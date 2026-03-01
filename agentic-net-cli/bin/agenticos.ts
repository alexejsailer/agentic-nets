import { createProgram } from '../src/index.js';

const program = createProgram();
program.parseAsync(process.argv).catch((err) => {
  console.error(err.message);
  process.exit(1);
});
