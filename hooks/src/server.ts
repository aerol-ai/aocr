import * as yargs from "yargs";
import * as hooksCommand from "./commands/hooks";
import * as reapCommand from "./commands/reap";

yargs
  .command(hooksCommand as any)
  .command(reapCommand as any)
  .env()
  .help()
  .demandCommand()
  .argv;
