import { startChatBridge } from '../src/index.js';

startChatBridge().catch((err) => {
  console.error('Fatal error:', err.message || err);
  process.exit(1);
});
