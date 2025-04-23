import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { SecretsManager } from "aws-sdk";
import { Pool } from "pg";
import * as redis from "redis";
import { promisify } from "util";

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

// Function to initialize Redis client
async function getRedisClient(): Promise<redis.RedisClientType> {
  if (!redisClient) {
    const redisHost = process.env.REDIS_HOST;
    const redisPort = process.env.REDIS_PORT;

    if (!redisHost || !redisPort) {
      throw new Error("Redis environment variables are not set");
    }

    console.log("[JOEY]Creating Redis client...");
    // Create Redis v4 client
    redisClient = redis.createClient({
      url: `redis://${redisHost}:${redisPort}`,
    });

    // Set up error handler
    redisClient.on("error", (err) => {
      console.error("Redis Client Error", err);
    });

    // Connect to Redis
    console.log("[JOEY] Connecting to Redis...");
    await redisClient.connect();
  }
  console.log("[JOEY] Redis client is ready");
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

// Get or create PostgreSQL pool
async function getPgPool(): Promise<Pool> {
  if (!pgPool) {
    const dbCredentials = await getDBCredentials();

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

// Handler for creating the table
async function handleCreateTable(): Promise<APIGatewayProxyResult> {
  const pool = await getPgPool();
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

// Process handler based on the route
async function processRequest(
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> {
  const path = event.path;
  const httpMethod = event.httpMethod;

  if (path.endsWith("/db/create-table")) {
    return handleCreateTable();
  } else if (path.endsWith("/db/insert")) {
    const requestBody = JSON.parse(event.body || "{}");
    return handleInsertRecord(requestBody);
  } else if (path.endsWith("/db/get-record") && httpMethod === "GET") {
    return handleGetRecord(event);
  } else {
    return {
      statusCode: 404,
      body: JSON.stringify({ message: "Route not found" }),
    };
  }
}

// Main Lambda handler
export const handler = async (
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> => {
  try {
    console.log("Received event:", JSON.stringify(event, null, 2));

    const result = await processRequest(event);

    return result;
  } catch (error) {
    console.error("Unhandled error:", error);
    return {
      statusCode: 500,
      body: JSON.stringify({
        message: "Internal server error",
        error: String(error),
      }),
    };
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
