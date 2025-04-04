import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as rds from "aws-cdk-lib/aws-rds";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as apigateway from "aws-cdk-lib/aws-apigateway";
import * as elasticache from "aws-cdk-lib/aws-elasticache";
// import * as iam from "aws-cdk-lib/aws-iam";
import { DatadogLambda } from "datadog-cdk-constructs-v2";

export class MyLambdaApiDbStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const datadog = new DatadogLambda(this, "Datadog", {
      nodeLayerVersion: 121,
      extensionLayerVersion: 75,
      site: "datadoghq.com",
      apiKey: "<your-datadog-api-key>",
      service: "aurora",
    });

    // Create a VPC with public and private subnets
    const vpc = new ec2.Vpc(this, "MyVPC", {
      maxAzs: 2,
      subnetConfiguration: [
        {
          cidrMask: 24,
          name: "public",
          subnetType: ec2.SubnetType.PUBLIC,
        },
        {
          cidrMask: 24,
          name: "private-db",
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
        },
        {
          cidrMask: 24,
          name: "private-lambda",
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
        },
      ],
    });

    // Security group for the Aurora PostgreSQL database
    const dbSecurityGroup = new ec2.SecurityGroup(this, "DBSecurityGroup", {
      vpc,
      description: "Allow database access",
    });

    // Allow inbound connections from the Lambda subnet CIDR
    const lambdaSubnets = vpc.selectSubnets({
      subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
    }).subnets;

    if (lambdaSubnets.length > 0) {
      lambdaSubnets.forEach((subnet) => {
        dbSecurityGroup.addIngressRule(
          ec2.Peer.ipv4(subnet.ipv4CidrBlock),
          ec2.Port.tcp(5432),
          `Allow PostgreSQL access from Lambda subnet ${subnet.subnetId}`
        );
      });
    }

    // Create the Aurora PostgreSQL cluster
    const dbCluster = new rds.DatabaseCluster(this, "Database", {
      engine: rds.DatabaseClusterEngine.auroraPostgres({
        version: rds.AuroraPostgresEngineVersion.VER_15_3,
      }),
      instanceProps: {
        vpc,
        vpcSubnets: {
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
        },
        instanceType: ec2.InstanceType.of(
          ec2.InstanceClass.BURSTABLE3,
          ec2.InstanceSize.MEDIUM
        ),
        securityGroups: [dbSecurityGroup],
      },
      defaultDatabaseName: "mydatabase",
      credentials: rds.Credentials.fromGeneratedSecret("dbadmin"),
    });

    // Security group for Redis
    const redisSecurityGroup = new ec2.SecurityGroup(
      this,
      "RedisSecurityGroup",
      {
        vpc,
        description: "Allow Redis access",
      }
    );

    // Allow inbound connections from the Lambda subnet CIDR
    const lambdaSubnetsForRedis = vpc.selectSubnets({
      subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
    }).subnets;

    if (lambdaSubnetsForRedis.length > 0) {
      lambdaSubnetsForRedis.forEach((subnet) => {
        redisSecurityGroup.addIngressRule(
          ec2.Peer.ipv4(subnet.ipv4CidrBlock),
          ec2.Port.tcp(6379),
          `Allow Redis access from Lambda subnet ${subnet.subnetId}`
        );
      });
    }

    // Create a subnet group for Redis
    const redisSubnetGroup = new elasticache.CfnSubnetGroup(
      this,
      "RedisSubnetGroup",
      {
        description: "Subnet group for Redis",
        subnetIds: vpc.selectSubnets({
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
        }).subnetIds,
      }
    );

    // Create Redis cluster
    const redisCluster = new elasticache.CfnCacheCluster(this, "RedisCluster", {
      cacheNodeType: "cache.t3.micro",
      engine: "redis",
      numCacheNodes: 1,
      cacheSubnetGroupName: redisSubnetGroup.ref,
      vpcSecurityGroupIds: [redisSecurityGroup.securityGroupId],
    });

    // Security group for Lambda
    const lambdaSecurityGroup = new ec2.SecurityGroup(
      this,
      "LambdaSecurityGroup",
      {
        vpc,
        description: "Security group for Lambda function",
      }
    );

    // Create Lambda function
    const lambdaFunction = new lambda.Function(this, "MyLambdaFunction", {
      runtime: lambda.Runtime.NODEJS_18_X,
      handler: "index.handler",
      code: lambda.Code.fromAsset("lib/lambda"),
      vpc,
      vpcSubnets: {
        subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
      },
      securityGroups: [lambdaSecurityGroup],
      environment: {
        DB_SECRET_ARN: dbCluster.secret!.secretArn,
        REDIS_HOST: redisCluster.attrRedisEndpointAddress,
        REDIS_PORT: redisCluster.attrRedisEndpointPort,
      },
      timeout: cdk.Duration.seconds(30),
    });

    datadog.addLambdaFunctions([lambdaFunction]);

    // Grant the Lambda function permission to read the DB secret
    dbCluster.secret!.grantRead(lambdaFunction);

    // Create API Gateway
    const api = new apigateway.RestApi(this, "MyApi", {
      deployOptions: {
        stageName: "prod",
      },
    });

    // Create the Lambda integration
    const lambdaIntegration = new apigateway.LambdaIntegration(lambdaFunction);

    // Add the routes
    const dbResource = api.root.addResource("db");

    // Route for creating the table
    const createTableResource = dbResource.addResource("create-table");
    createTableResource.addMethod("POST", lambdaIntegration);

    // Route for inserting records
    const insertResource = dbResource.addResource("insert");
    insertResource.addMethod("POST", lambdaIntegration);

    // Route for checking records
    const getRecordResource = dbResource.addResource("get-record");
    getRecordResource.addMethod("GET", lambdaIntegration);

    // Output the API URL
    new cdk.CfnOutput(this, "ApiUrl", {
      value: api.url,
    });

    // Output the DB secret ARN
    new cdk.CfnOutput(this, "DBSecretArn", {
      value: dbCluster.secret!.secretArn,
    });
  }
}
