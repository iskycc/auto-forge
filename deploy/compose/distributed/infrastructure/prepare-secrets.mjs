import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";

const directory = resolve(process.argv[2] ?? "secrets");
if (existsSync(directory))
  throw new Error("Secret directory already exists; preserve the deployed credentials.");
const randomSecret = () => randomBytes(32).toString("base64url");
const natsToken = randomSecret();
const redisPassword = randomSecret();
const files = {
  "postgres-password": randomSecret(),
  "minio-root-user": "autoforge",
  "minio-root-password": randomSecret(),
  "nats-token": natsToken,
  "nats.conf": `jetstream { store_dir: "/data" }\nhttp_port: 8222\nauthorization { token: "${natsToken}" }\n`,
  "redis-password": redisPassword,
  "redis.conf": `bind 0.0.0.0\nprotected-mode yes\nrequirepass "${redisPassword}"\nappendonly yes\nsave 60 1\ndir /data\n`,
};
mkdirSync(directory, { mode: 0o700, recursive: true });
for (const [name, content] of Object.entries(files))
  writeFileSync(join(directory, name), content + "\n", { flag: "wx", mode: 0o600 });
process.stdout.write(
  "Generated private infrastructure secret files. Distribute each service only its own files.\n",
);
