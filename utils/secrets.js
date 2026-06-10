const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');

const client = new SecretsManagerClient({ region: 'ap-southeast-1' });
const SECRET_NAME = process.env.SECRET_NAME || 'lambda-common-secrets';

async function getSecrets() {
  // Skip Secrets Manager in local development
  if (process.env.USE_LOCAL_ENV === 'true') {
    console.log('Using local environment variables (USE_LOCAL_ENV=true)');
    return {};
  }

  try {
    const command = new GetSecretValueCommand({ SecretId: SECRET_NAME });
    const response = await client.send(command);
    return JSON.parse(response.SecretString);
  } catch (error) {
    console.error('Failed to fetch secrets from AWS Secrets Manager:', error.message);
    throw error;
  }
}

module.exports = { getSecrets };
