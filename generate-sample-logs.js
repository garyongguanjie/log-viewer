const fs = require("fs");
const path = require("path");
const { once } = require("events");
const Papa = require("./papaparse.js");

const outputs = [
  { name: "springboot-small.log", lines: 250 },
  { name: "springboot-medium.log", lines: 10_000 },
  { name: "springboot-large.log", lines: 100_000 }
];
const longLineOutputs = [
  { name: "springboot-long-lines.log", lines: 24, maximumLength: 32_768 },
  { name: "springboot-long-lines-large.log", lines: 2_500, maximumLength: 8_192 }
];
const outputDirectory = path.join(__dirname, "sample_logs");

const applications = [
  "com.example.orders.OrderService",
  "com.example.payments.PaymentClient",
  "com.example.inventory.StockSyncJob",
  "com.example.shipping.ShipmentService",
  "com.example.users.AuthenticationService"
];

const levels = ["INFO", "INFO", "INFO", "DEBUG", "DEBUG", "WARN", "ERROR", "TRACE"];
const threads = ["main", "http-nio-8080-exec-1", "http-nio-8080-exec-7", "scheduling-1", "kafka-listener-0-C-1"];
const services = ["orders-service", "payments-service", "inventory-service", "shipping-service", "users-service"];

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
  const destination = path.join(outputDirectory, name);
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

function longMessage(index, maximumLength) {
  const lengths = [512, 2_048, maximumLength];
  const length = lengths[index % lengths.length];
  if (index % 3 === 0) return `unbrokenToken=${"X".repeat(length)}`;
  if (index % 3 === 1) return `wrappedWords=${"long-log-value ".repeat(Math.ceil(length / 15)).slice(0, length)}`;
  return `payload={"requestId":"stress-${index}","description":"${"J".repeat(length)}","status":"READY","retryable":false}`;
}

async function writeLongLineLog({ name, lines, maximumLength }) {
  const destination = path.join(outputDirectory, name);
  const stream = fs.createWriteStream(destination, { encoding: "utf8" });

  for (let index = 0; index < lines; index += 1) {
    const level = levels[index % levels.length];
    const app = applications[index % applications.length];
    const thread = threads[index % threads.length];
    const line = `${timestamp(index)} ${level.padStart(5, " ")} 18420 --- [${thread}] ${app} : ${longMessage(index, maximumLength)}\n`;
    if (!stream.write(line)) await once(stream, "drain");
  }

  stream.end();
  await once(stream, "finish");
  const size = fs.statSync(destination).size;
  console.log(`${name}: ${lines.toLocaleString()} lines, ${(size / 1024 / 1024).toFixed(2)} MB`);
}

function csvMessage(index) {
  if (index % 29 === 0) return `Multiline diagnostic for request ${index}\nConnection pool exhausted\nRetry scheduled in 5000ms`;
  if (index % 23 === 0) return `Gateway replied "rate limited", retrying request ${index}`;
  if (index % 19 === 0) return `Processed order ${index}, warehouse=eu-west-1, items=4`;
  if (index % 17 === 0) return `payload={"requestId":"csv-${index}","status":"READY","items":[1,2,3]}`;
  return message(index, levels[index % levels.length]);
}

function kibanaRows(count) {
  return Array.from({ length: count }, (_, index) => ({
    "@timestamp": new Date(Date.UTC(2026, 7, 15, 9, 0, 0, index * 137)).toISOString(),
    "log.level": index % 13 === 0 ? "" : index % 31 === 0 ? "NOTICE" : levels[index % levels.length],
    "service.name": services[index % services.length],
    message: csvMessage(index)
  }));
}

function writeCsv(name, rows, config = {}) {
  const destination = path.join(outputDirectory, name);
  fs.writeFileSync(destination, `${Papa.unparse(rows, config)}\n`, "utf8");
  const size = fs.statSync(destination).size;
  console.log(`${name}: ${rows.length.toLocaleString()} records, ${(size / 1024 / 1024).toFixed(2)} MB`);
}

function writeCsvSamples() {
  writeCsv("kibana-standard.csv", kibanaRows(60));
  writeCsv("kibana-large.csv", kibanaRows(10_000));
  writeCsv("kibana-semicolon.csv", kibanaRows(30), { delimiter: ";" });
  writeCsv("kibana-alternate-columns.csv", Array.from({ length: 40 }, (_, index) => ({
    timestamp: new Date(Date.UTC(2026, 7, 16, 10, 0, 0, index * 251)).toISOString(),
    severity: index % 9 === 0 ? "" : ["info", "warning", "err", "critical", "debug"][index % 5],
    application: services[index % services.length],
    "event.original": csvMessage(index)
  })));
}

(async () => {
  if (process.argv.includes("--csv")) {
    writeCsvSamples();
    return;
  }
  const selectedOutputs = process.argv.includes("--long-lines") ? longLineOutputs : outputs;
  const writer = process.argv.includes("--long-lines") ? writeLongLineLog : writeLog;
  for (const output of selectedOutputs) await writer(output);
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
