import { APIGatewayProxyEvent, APIGatewayProxyResult, CloudFormationCustomResourceEvent } from "aws-lambda";
import { SecretsManager } from "aws-sdk";
import { Pool } from "pg";
import * as redis from "redis";
import * as https from "https";
import * as url from "url";

interface DBSecret {
  username: string;
  password: string;
  host: string;
  port: number;
  dbname: string;
}

// Initialize the SecretManager client
const secretsManager = new SecretsManager();

// Database connection pool
let pgPool: Pool | null = null;

// Redis client setup - using v4 client
let redisClient: redis.RedisClientType | null = null;

// Function to get DB credentials from Secrets Manager
async function getDBCredentials(): Promise<DBSecret> {
  console.log("[JOEY] Getting DB credentials from Secrets Manager");
  const secretArn = process.env.DB_SECRET_ARN;
  if (!secretArn) {
    throw new Error("DB_SECRET_ARN environment variable is not set");
  }

  const data = await secretsManager
    .getSecretValue({ SecretId: secretArn })
    .promise();
  if (!data.SecretString) {
    throw new Error("Secret string is empty");
  }

  return JSON.parse(data.SecretString) as DBSecret;
}

// Get or create PostgreSQL pool
async function getPgPool(): Promise<Pool> {
  console.log("[JOEY] Getting PostgreSQL pool");
  if (!pgPool) {
    const dbCredentials = await getDBCredentials();
    console.log("[JOEY] DB Credentials", dbCredentials);
    pgPool = new Pool({
      user: dbCredentials.username,
      password: dbCredentials.password,
      host: dbCredentials.host,
      port: dbCredentials.port,
      database: dbCredentials.dbname,
      ssl: {
        rejectUnauthorized: false, // For development - configure properly for production
      },
      max: 20, // Maximum number of clients in the pool
      idleTimeoutMillis: 30000, // How long a client is allowed to remain idle before being closed
      connectionTimeoutMillis: 2000, // How long to wait for a connection
    });

    // Handle pool errors
    pgPool.on("error", (err) => {
      console.error("Unexpected error on idle client", err);
      pgPool = null;
    });
  }

  return pgPool;
}

// Function to initialize Redis client
async function getRedisClient(): Promise<redis.RedisClientType> {
  if (!redisClient) {
    const redisHost = process.env.REDIS_HOST;
    const redisPort = process.env.REDIS_PORT;

    if (!redisHost || !redisPort) {
      throw new Error("Redis environment variables are not set");
    }

    // Create Redis v4 client
    redisClient = redis.createClient({
      url: `redis://${redisHost}:${redisPort}`,
    });

    // Set up error handler
    redisClient.on("error", (err) => {
      console.error("Redis Client Error", err);
    });

    // Connect to Redis
    await redisClient.connect();
  }

  return redisClient;
}

// Redis operations with v4 client
async function redisGet(key: string): Promise<string | null> {
  try {
    const client = await getRedisClient();
    return await client.get(key);
  } catch (error) {
    console.error("Error getting from Redis:", error);
    // Return null on error so we can fall back to database
    return null;
  }
}

async function redisSet(key: string, value: string): Promise<void> {
  try {
    const client = await getRedisClient();
    await client.set(key, value);
  } catch (error) {
    console.error("Error setting to Redis:", error);
    // Just log the error but don't fail the operation
  }
}

// Handler for creating the table
async function handleCreateTable(): Promise<APIGatewayProxyResult> {
  console.log("[JOEY] Creating table");
  const pool = await getPgPool();
  console.log("[JOEY] connecting to PostgreSQL");
  const client = await pool.connect();

  try {
    // SQL for creating the table
    const createTableSQL = `
      CREATE TABLE IF NOT EXISTS your_table (
        id SERIAL PRIMARY KEY,
        parameter VARCHAR(255) NOT NULL,
        value TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `;

    await client.query(createTableSQL);

    return {
      statusCode: 200,
      body: JSON.stringify({
        message: "Table created successfully",
      }),
    };
  } catch (error) {
    console.error("Error creating table:", error);
    return {
      statusCode: 500,
      body: JSON.stringify({
        message: "Error creating table",
        error: String(error),
      }),
    };
  } finally {
    // Release client back to the pool
    client.release();
  }
}

// Handler for inserting records
async function handleInsertRecord(
  requestBody: any
): Promise<APIGatewayProxyResult> {
  const pool = await getPgPool();
  const client = await pool.connect();

  try {
    // Validate input
    const { parameter, value } = requestBody;

    if (!parameter || !value) {
      return {
        statusCode: 400,
        body: JSON.stringify({
          message:
            'Missing required parameters. Both "parameter" and "value" are required.',
        }),
      };
    }

    // Insert the record
    const insertSQL = `
      INSERT INTO your_table (parameter, value)
      VALUES ($1, $2)
      RETURNING id, parameter, value, created_at
    `;

    const result = await client.query(insertSQL, [parameter, value]);

    // Cache the result in Redis
    const insertedRecord = result.rows[0];
    const redisKey = `record:${insertedRecord.id}`;
    await redisSet(redisKey, JSON.stringify(insertedRecord));

    return {
      statusCode: 201,
      body: JSON.stringify({
        message: "Record inserted successfully",
        record: insertedRecord,
        cached: true,
        redisKey,
      }),
    };
  } catch (error) {
    console.error("Error inserting record:", error);
    return {
      statusCode: 500,
      body: JSON.stringify({
        message: "Error inserting record",
        error: String(error),
      }),
    };
  } finally {
    client.release();
  }
}

// Handler for getting records
async function handleGetRecord(
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> {
  const pool = await getPgPool();
  const client = await pool.connect();

  try {
    // Get parameter from query parameters
    const queryParams = event.queryStringParameters || {};
    const parameter = queryParams.parameter;

    if (!parameter) {
      return {
        statusCode: 400,
        body: JSON.stringify({
          message: 'Missing required query parameter "parameter"',
        }),
      };
    }

    // First, try to get the record from Redis
    // Create a cache key based on the parameter
    const cacheKey = `param:${parameter}`;
    const cachedData = await redisGet(cacheKey);

    if (cachedData) {
      console.log("Data found in Redis cache");
      return {
        statusCode: 200,
        body: JSON.stringify({
          source: "cache",
          records: JSON.parse(cachedData),
        }),
      };
    }

    // If not in cache, query the database
    const querySQL = `
      SELECT id, parameter, value, created_at
      FROM your_table
      WHERE parameter = $1
    `;

    const result = await client.query(querySQL, [parameter]);
    const records = result.rows;

    // Cache the result in Redis
    if (records.length > 0) {
      await redisSet(cacheKey, JSON.stringify(records));
    }

    return {
      statusCode: 200,
      body: JSON.stringify({
        source: "database",
        records: records,
        count: records.length,
      }),
    };
  } catch (error) {
    console.error("Error getting records:", error);
    return {
      statusCode: 500,
      body: JSON.stringify({
        message: "Error getting records",
        error: String(error),
      }),
    };
  } finally {
    client.release();
  }
}

// Handler for testing database connections
async function handleTestConnections(): Promise<APIGatewayProxyResult> {
  let pgClient = null;
  const results = {
    pgConnection: { success: false, message: "" },
    redisConnection: { success: false, message: "" },
  };

  try {
    // Test PostgreSQL connection
    console.log("Testing PostgreSQL connection...");
    const pool = await getPgPool();
    pgClient = await pool.connect();

    // Try a simple query
    const pgResult = await pgClient.query("SELECT NOW() as current_time");
    results.pgConnection.success = true;
    results.pgConnection.message = `Successfully connected to PostgreSQL. Current time: ${pgResult.rows[0].current_time}`;

    // Test Redis connection
    console.log("Testing Redis connection...");
    try {
      const redisClient = await getRedisClient();
      await redisClient.set("test-key", "Connection test successful");
      const redisValue = await redisClient.get("test-key");

      results.redisConnection.success = true;
      results.redisConnection.message = `Successfully connected to Redis. Test value: ${redisValue}`;
    } catch (redisError) {
      results.redisConnection.message = `Redis connection failed: ${redisError}`;
      console.error("Redis connection test failed:", redisError);
    }

    return {
      statusCode: 200,
      body: JSON.stringify(results),
    };
  } catch (error) {
    console.error("Error testing connections:", error);
    if (!results.pgConnection.success) {
      results.pgConnection.message = `PostgreSQL connection failed: ${error}`;
    }

    return {
      statusCode: 500,
      body: JSON.stringify({
        message: "Error testing database connections",
        error: String(error),
        results,
      }),
    };
  } finally {
    if (pgClient) {
      pgClient.release();
    }
  }
}

// Process handler based on the route
async function processRequest(
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> {
  const path = event.path;
  const httpMethod = event.httpMethod;
  
  console.log(`Processing request: ${httpMethod} ${path}`);
  
  // Added debugging
  console.log("Environment variables:");
  console.log("DB_SECRET_ARN:", process.env.DB_SECRET_ARN);
  console.log("REDIS_HOST:", process.env.REDIS_HOST);
  console.log("REDIS_PORT:", process.env.REDIS_PORT);

  if (path.endsWith("/db/test-connections")) {
    return handleTestConnections();
  } else if (path.endsWith("/db/create-table")) {
    return handleCreateTable();
  } else if (path.endsWith("/db/insert")) {
    const requestBody = JSON.parse(event.body || "{}");
    return handleInsertRecord(requestBody);
  } else if (path.endsWith("/db/get-record") && httpMethod === "GET") {
    return handleGetRecord(event);
  } else {
    return {
      statusCode: 404,
      body: JSON.stringify({ 
        message: "Route not found",
        requestedPath: path,
        method: httpMethod,
      }),
    };
  }
}

// Function to send response to CloudFormation
async function sendCloudFormationResponse(
  event: CloudFormationCustomResourceEvent,
  status: 'SUCCESS' | 'FAILED',
  data: any = {},
  physicalResourceId?: string,
  reason?: string
): Promise<void> {
  const responseBody = JSON.stringify({
    Status: status,
    Reason: reason || "See the details in CloudWatch Log Stream",
    PhysicalResourceId: physicalResourceId || event.RequestId,
    StackId: event.StackId,
    RequestId: event.RequestId,
    LogicalResourceId: event.LogicalResourceId,
    NoEcho: false,
    Data: data
  });
  
  console.log("Response body:\n", responseBody);
  
  const parsedUrl = url.parse(event.ResponseURL);
  const options = {
    hostname: parsedUrl.hostname,
    port: 443,
    path: parsedUrl.path,
    method: "PUT",
    headers: {
      "content-type": "",
      "content-length": responseBody.length
    }
  };
  
  return new Promise((resolve, reject) => {
    const request = https.request(options, response => {
      console.log("Status code: " + response.statusCode);
      resolve();
    });
    
    request.on("error", error => {
      console.error("send:", error);
      reject(error);
    });
    
    request.write(responseBody);
    request.end();
  });
}

// Handler for updating Secrets Manager with database endpoint
async function handleSecretUpdate(event: CloudFormationCustomResourceEvent): Promise<void> {
  console.log('Received CloudFormation event:', JSON.stringify(event, null, 2));
  
  // For Delete requests, immediately send a success response
  if (event.RequestType === 'Delete') {
    await sendCloudFormationResponse(event, 'SUCCESS');
    return;
  }
  
  try {
    console.log('Updating database secret with Aurora endpoint');
    console.log('Secret ID:', event.ResourceProperties.SecretId);
    console.log('DB Endpoint:', event.ResourceProperties.DbEndpoint);
    
    // Get the current secret
    const secretData = await secretsManager.getSecretValue({
      SecretId: event.ResourceProperties.SecretId
    }).promise();
    
    if (!secretData.SecretString) {
      throw new Error('Secret string is empty');
    }
    
    const secret = JSON.parse(secretData.SecretString);
    console.log('Current secret:', JSON.stringify(secret, null, 2));
    
    // Update with Aurora endpoint and port
    const updatedSecret = {
      ...secret,
      host: event.ResourceProperties.DbEndpoint,
      port: 5432,
      dbname: 'mydatabase'
    };
    
    console.log('Updated secret:', JSON.stringify(updatedSecret, null, 2));
    
    // Update the secret
    await secretsManager.updateSecret({
      SecretId: event.ResourceProperties.SecretId,
      SecretString: JSON.stringify(updatedSecret)
    }).promise();
    
    console.log('Secret updated successfully!');
    
    await sendCloudFormationResponse(event, 'SUCCESS', {
      Message: 'Secret updated successfully'
    });
  } catch (error) {
    console.error('Error updating secret:', error);
    await sendCloudFormationResponse(
      event, 
      'FAILED', 
      {}, 
      undefined, 
      typeof error === 'object' ? (error as Error).message : String(error)
    );
  }
}

// Main Lambda handler
export const handler = async (event: any): Promise<any> => {
  try {
    console.log("Received event:", JSON.stringify(event, null, 2));

    // Determine if this is a CloudFormation custom resource event
    if (event.ResourceType === 'Custom::UpdateSecret' || 
        (event.RequestType && ['Create', 'Update', 'Delete'].includes(event.RequestType))) {
      // Handle as CloudFormation custom resource event
      await handleSecretUpdate(event as CloudFormationCustomResourceEvent);
      return; // No response needed for CloudFormation, it's handled by sendCloudFormationResponse
    } else {
      // Handle as API Gateway event
      const result = await processRequest(event as APIGatewayProxyEvent);
      return result;
    }
  } catch (error) {
    console.error("Unhandled error:", error);
    
    // For API Gateway events, return a 500 response
    if (!('ResourceType' in event)) {
      return {
        statusCode: 500,
        body: JSON.stringify({
          message: "Internal server error",
          error: String(error),
        }),
      };
    }
    // For CloudFormation events, make sure we send a response
    if ('ResponseURL' in event) {
      try {
        await sendCloudFormationResponse(
          event as CloudFormationCustomResourceEvent, 
          'FAILED', 
          {}, 
          undefined, 
          String(error)
        );
      } catch (responseError) {
        console.error("Failed to send error response to CloudFormation:", responseError);
      }
    }
    throw error;
  } finally {
    // For Redis v4, we don't need to quit if we're keeping connections warm
    // If you DO want to close connections for any reason, use:
    // if (redisClient && redisClient.isOpen) {
    //   await redisClient.quit();
    //   redisClient = null;
    // }
    // We don't end the pool connection here as it would be reused
    // in subsequent Lambda invocations while the container is warm.
    // AWS Lambda will clean up resources when the container is recycled.
  }
};
