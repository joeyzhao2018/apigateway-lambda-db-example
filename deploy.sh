#!/bin/bash

# Exit on error
set -e

echo "Building Lambda function..."
cd lambda
npm install
rm -rf ./dist && npm run build
cd ..

echo "Building and deploying with SAM..."
./build.sh
sam deploy --guided

echo "Deployment complete!"
echo "Retrieving API URL..."
API_URL=$(aws cloudformation describe-stacks --stack-name sam-lambda-api-db --query "Stacks[0].Outputs[?OutputKey=='ApiURL'].OutputValue" --output text)

echo "API URL: $API_URL"
echo ""
echo "Example commands to test the API:"
echo ""
echo "# Create table"
echo "curl -X POST ${API_URL}db/create-table"
echo ""
echo "# Insert record"
echo "curl -X POST ${API_URL}db/insert -H \"Content-Type: application/json\" -d '{\"parameter\": \"test_param\", \"value\": \"test_value\"}'"
echo ""
echo "# Get record"
echo "curl -X GET \"${API_URL}db/get-record?parameter=test_param\""
