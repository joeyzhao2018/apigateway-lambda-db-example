cd lambda

rm -rf dist

# Install development dependencies
npm install

# Compile TypeScript
npm run build

# Install production dependencies in the dist folder
cp package.json dist/

cd dist
npm install --only=production

# Zip the package

cd ../..

sam build
