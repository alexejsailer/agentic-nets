import { startChatBridge } from '../src/index.js';
import { log } from '../src/logger.js';

startChatBridge().catch((err) => {
  log.error('Fatal error:', err.message || err);
  process.exit(1);
});
