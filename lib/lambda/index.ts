// Handler for getting records
async function handleGetRecord(
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> {
  let client: Client | null = null;

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
    client = await createPgClient();

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
    if (client) {
      await client.end();
    }
  }
}
import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { SecretsManager } from "aws-sdk";
import { Client } from "pg";
import * as Redis from "redis";
import { promisify } from "util";

interface DBSecret {
  username: string;
  password: string;
  host: string;
  port: number;
  dbname: string;
}

// Initialize the SecretManager client
const secretsManager = new SecretsManager();

// Redis client setup
let redisClient: Redis.RedisClient | null = null;

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
function getRedisClient(): Redis.RedisClient {
  if (!redisClient) {
    const redisHost = process.env.REDIS_HOST;
    const redisPort = process.env.REDIS_PORT;

    if (!redisHost || !redisPort) {
      throw new Error("Redis environment variables are not set");
    }

    redisClient = Redis.createClient({
      host: redisHost,
      port: parseInt(redisPort, 10),
    });
  }

  return redisClient;
}

// Promisify Redis get and set methods
async function redisGet(key: string): Promise<string | null> {
  const client = getRedisClient();
  const getAsync = promisify(client.get).bind(client);
  return getAsync(key);
}

async function redisSet(key: string, value: string): Promise<unknown> {
  const client = getRedisClient();
  const setAsync = promisify(client.set).bind(client);
  return setAsync(key, value);
}

// Create PostgreSQL client
async function createPgClient(): Promise<Client> {
  const dbCredentials = await getDBCredentials();

  const client = new Client({
    user: dbCredentials.username,
    password: dbCredentials.password,
    host: dbCredentials.host,
    port: dbCredentials.port,
    database: dbCredentials.dbname,
    ssl: {
      rejectUnauthorized: false, // For development - configure properly for production
    },
  });

  await client.connect();
  return client;
}

// Handler for creating the table
async function handleCreateTable(): Promise<APIGatewayProxyResult> {
  let client: Client | null = null;

  try {
    client = await createPgClient();

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
    if (client) {
      await client.end();
    }
  }
}

// Handler for inserting records
async function handleInsertRecord(
  requestBody: any
): Promise<APIGatewayProxyResult> {
  let client: Client | null = null;

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

    client = await createPgClient();

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
    if (client) {
      await client.end();
    }
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

    return await processRequest(event);
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
    // Clean up Redis connection if it exists
    if (redisClient) {
      redisClient.quit();
      redisClient = null;
    }
  }
};
