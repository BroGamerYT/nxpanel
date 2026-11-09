import dotenv from 'dotenv';
dotenv.config();

export const config = {
  port: parseInt(process.env.NEXUSCORE_PORT || '8443', 10),
  host: process.env.NEXUSCORE_HOST || '0.0.0.0',
  mode: process.env.NEXUSCORE_MODE || 'test', // 'test' | 'production'
  runtime: (process.env.NEXUSCORE_RUNTIME || (process.platform === 'win32' ? 'windows-native' : 'docker')) as 'windows-native' | 'docker' | 'mock',
  pairingPin: process.env.NEXUSCORE_PAIRING_PIN || '123456',
  secretToken: process.env.NEXUSCORE_SECRET_TOKEN || 'local-test-secret-key-2026',
};
