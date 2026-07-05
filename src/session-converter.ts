import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { StringSession } from "telegram/sessions/index.js";

interface TelethonSessionRow {
  dc_id: number;
  server_address: string;
  port: number;
  auth_key: Uint8Array;
}

export function telethonSqliteToGramjsString(sessionPath: string): string {
  const db = new DatabaseSync(sessionPath, { readOnly: true });
  try {
    const row = db.prepare(`
      SELECT dc_id, server_address, port, auth_key
      FROM sessions
      WHERE auth_key IS NOT NULL
      LIMIT 1
    `).get() as TelethonSessionRow | undefined;

    if (!row) throw new Error(`No auth_key row found in Telethon session: ${sessionPath}`);

    const dcBuffer = Buffer.from([row.dc_id]);
    const addressBuffer = Buffer.from(row.server_address);
    const addressLengthBuffer = Buffer.alloc(2);
    addressLengthBuffer.writeInt16BE(addressBuffer.length, 0);
    const portBuffer = Buffer.alloc(2);
    portBuffer.writeInt16BE(row.port, 0);
    const authKeyBuffer = Buffer.from(row.auth_key);

    return `1${StringSession.encode(Buffer.concat([
      dcBuffer,
      addressLengthBuffer,
      addressBuffer,
      portBuffer,
      authKeyBuffer,
    ]))}`;
  } finally {
    db.close();
  }
}

export function convertTelethonSessionFile(inputPath = "../telegram-poke-bridge.session", outputPath = "./data/telegram-string-session.txt"): void {
  const absoluteInput = resolve(process.cwd(), inputPath);
  const absoluteOutput = resolve(process.cwd(), outputPath);
  const stringSession = telethonSqliteToGramjsString(absoluteInput);
  mkdirSync(dirname(absoluteOutput), { recursive: true });
  writeFileSync(absoluteOutput, `${stringSession}\n`, { mode: 0o600 });
  console.log(`Wrote GramJS string session to ${absoluteOutput}`);
}
