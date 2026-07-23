import { readFileSync } from "node:fs";
import type { EnvironmentId } from "./cloudboard";

export interface AwsEnvironmentConfig {
  id: EnvironmentId;
  name: string;
  regions: string[];
  credentials: {
    accessKeyId: string;
    secretAccessKey: string;
    sessionToken?: string;
  };
}

const defaultEnvironmentNames: Record<EnvironmentId, string> = {
  dev: "Development",
  prd: "Production",
};

function parseRegions(value: string | undefined) {
  const regions = (value ?? "ap-northeast-2")
    .split(",")
    .map((region) => region.trim())
    .filter(Boolean);

  return [...new Set(regions)].slice(0, 10);
}

function parseCredentialsFile(path: string | undefined) {
  if (!path) {
    return null;
  }

  const [headerLine, valueLine] = readFileSync(path, "utf8")
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/, 2);
  if (!headerLine || !valueLine) {
    throw new Error("AWS credentials file is empty.");
  }

  const headers = headerLine.split(",").map((value) => value.trim());
  const values = valueLine.split(",").map((value) => value.trim());
  const accessKeyIndex = headers.indexOf("Access key ID");
  const secretKeyIndex = headers.indexOf("Secret access key");
  const accessKeyId = values[accessKeyIndex];
  const secretAccessKey = values[secretKeyIndex];

  if (
    accessKeyIndex < 0 ||
    secretKeyIndex < 0 ||
    !accessKeyId ||
    !secretAccessKey
  ) {
    throw new Error("AWS credentials file has an invalid format.");
  }

  return { accessKeyId, secretAccessKey };
}

export function getEnvironmentConfig(
  environmentId: EnvironmentId,
): AwsEnvironmentConfig | null {
  const prefix = `AWS_${environmentId.toUpperCase()}`;
  const fileCredentials = parseCredentialsFile(
    process.env[`${prefix}_CREDENTIALS_FILE`]?.trim(),
  );
  const accessKeyId =
    process.env[`${prefix}_ACCESS_KEY_ID`]?.trim() ??
    fileCredentials?.accessKeyId;
  const secretAccessKey =
    process.env[`${prefix}_SECRET_ACCESS_KEY`]?.trim() ??
    fileCredentials?.secretAccessKey;
  const sessionToken = process.env[`${prefix}_SESSION_TOKEN`]?.trim();

  if (!accessKeyId || !secretAccessKey) {
    return null;
  }

  return {
    id: environmentId,
    name:
      process.env[`${prefix}_NAME`]?.trim() ??
      defaultEnvironmentNames[environmentId],
    regions: parseRegions(process.env[`${prefix}_REGIONS`]),
    credentials: {
      accessKeyId,
      secretAccessKey,
      ...(sessionToken ? { sessionToken } : {}),
    },
  };
}

export function getEnvironmentName(environmentId: EnvironmentId) {
  const prefix = `AWS_${environmentId.toUpperCase()}`;
  return (
    process.env[`${prefix}_NAME`]?.trim() ??
    defaultEnvironmentNames[environmentId]
  );
}
