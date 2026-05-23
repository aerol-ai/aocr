import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import * as hooksCommand from "./commands/hooks";
import * as reapCommand from "./commands/reap";

yargs(hideBin(process.argv))
  .command(hooksCommand as any)
  .command(reapCommand as any)
  .env()
  .help()
  .demandCommand()
  .parse();
