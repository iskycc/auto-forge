import { dirname, basename } from "node:path";
import { PlatformConfigurationStore } from "@autoforge/platform-config";
import { prepareDistributedNode } from "../src/lib/prepare-distributed-node.ts";

const argumentsList = process.argv.slice(2);
const source = argumentsList[0];
const output = argumentsList[1];
const identity = argumentsList[2];
if (
  !source ||
  !output ||
  basename(source) !== "platform.json" ||
  !["original", "new"].includes(identity ?? "") ||
  argumentsList.length !== 3
) {
  throw new Error(
    "usage: prepare-node.js SOURCE/config/platform.json OUTPUT/config/platform.json original|new",
  );
}
const store = new PlatformConfigurationStore(dirname(dirname(source)));
const nodeId = prepareDistributedNode(store.read(), output, identity as "original" | "new");
process.stdout.write(
  `Prepared distributed node ${nodeId}. Protect the generated configuration file.\n`,
);
