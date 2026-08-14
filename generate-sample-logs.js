const fs = require("fs");
const path = require("path");
const { once } = require("events");

const outputs = [
  { name: "springboot-small.log", lines: 250 },
  { name: "springboot-medium.log", lines: 10_000 },
  { name: "springboot-large.log", lines: 100_000 }
];

const applications = [
  "com.example.orders.OrderService",
  "com.example.payments.PaymentClient",
  "com.example.inventory.StockSyncJob",
  "com.example.shipping.ShipmentService",
  "com.example.users.AuthenticationService"
];

const levels = ["INFO", "INFO", "INFO", "DEBUG", "DEBUG", "WARN", "ERROR", "TRACE"];
const threads = ["main", "http-nio-8080-exec-1", "http-nio-8080-exec-7", "scheduling-1", "kafka-listener-0-C-1"];

function timestamp(index) {
  const date = new Date(Date.UTC(2026, 7, 15, 9, 0, 0, index * 137));
  return date.toISOString().replace("T", " ").replace("Z", "");
}

function message(index, level) {
  const requestId = `req-${String(index).padStart(8, "0")}`;
  const orderId = `ORD-${100000 + index}`;

  if (index % 997 === 0) {
    return `Request ${requestId} failed for ${orderId}: upstream payment gateway timed out after 30000ms; retry budget exhausted; correlationId=corr-${index}; endpoint=https://payments.internal.example/api/v2/authorizations; diagnosticContext=${"connection-pool-saturated ".repeat(18).trim()}`;
  }
  if (index % 251 === 0) {
    return `Inventory event payload received requestId=${requestId} payload={"orderId":"${orderId}","warehouse":"eu-west-1-a","items":[${Array.from({ length: 18 }, (_, item) => `{"sku":"SKU-${index}-${item}","quantity":${item + 1}}`).join(",")}],"priority":"EXPRESS"}`;
  }
  if (level === "ERROR") return `Unable to process ${orderId}; requestId=${requestId}; cause=Database connection unavailable; retryable=true`;
  if (level === "WARN") return `Slow request detected for ${orderId}; requestId=${requestId}; elapsedMs=${1500 + index % 4000}; thresholdMs=1000`;
  if (level === "DEBUG" || level === "TRACE") return `Processing state transition requestId=${requestId} orderId=${orderId} from=VALIDATED to=FULFILLMENT_ATTEMPT_${index % 4}`;
  return `Completed requestId=${requestId} orderId=${orderId} status=200 elapsedMs=${20 + index % 480}`;
}

async function writeLog({ name, lines }) {
  const destination = path.join(__dirname, name);
  const stream = fs.createWriteStream(destination, { encoding: "utf8" });

  for (let index = 0; index < lines; index += 1) {
    const level = levels[index % levels.length];
    const paddedLevel = level.padStart(5, " ");
    const app = applications[index % applications.length];
    const thread = threads[index % threads.length];
    const line = `${timestamp(index)} ${paddedLevel} 18420 --- [${thread}] ${app} : ${message(index, level)}\n`;
    if (!stream.write(line)) await once(stream, "drain");
  }

  stream.end();
  await once(stream, "finish");
  const size = fs.statSync(destination).size;
  console.log(`${name}: ${lines.toLocaleString()} lines, ${(size / 1024 / 1024).toFixed(2)} MB`);
}

(async () => {
  for (const output of outputs) await writeLog(output);
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
