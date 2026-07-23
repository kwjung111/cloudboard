import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  EnvironmentId,
  EnvironmentInput,
  EnvironmentSummary,
} from "./cloudboard";
import {
  findEnvironment,
  listEnvironments,
} from "./environment-store";

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

function environmentPrefix(environmentId: string) {
  return `AWS_${environmentId.replaceAll("-", "_").toUpperCase()}`;
}

function credentialsPaths(credentialRef: string) {
  const directories = [
    process.env.CLOUDBOARD_CREDENTIALS_DIR?.trim() || "/run/secrets",
    process.env.CLOUDBOARD_DYNAMIC_CREDENTIALS_DIR?.trim(),
  ].filter((directory): directory is string => Boolean(directory));
  return directories.map((directory) => join(directory, `${credentialRef}.csv`));
}

function credentialsPath(credentialRef: string) {
  const paths = credentialsPaths(credentialRef);
  return paths.find(existsSync) ?? paths[0];
}

function configured(environmentId: string, credentialRef: string) {
  const prefix = environmentPrefix(environmentId);
  return Boolean(
    (process.env[`${prefix}_ACCESS_KEY_ID`]?.trim() &&
      process.env[`${prefix}_SECRET_ACCESS_KEY`]?.trim()) ||
      credentialsPaths(credentialRef).some(existsSync),
  );
}

function parseCredentialsFile(path: string) {
  if (!existsSync(path)) {
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

function summary(environment: EnvironmentInput): EnvironmentSummary {
  return {
    ...environment,
    configured: configured(environment.id, environment.credentialRef),
  };
}

export function getEnvironmentSummaries(): EnvironmentSummary[] {
  return listEnvironments().map(summary);
}

export function getEnvironmentSummary(
  environmentId: string,
): EnvironmentSummary | null {
  const environment = findEnvironment(environmentId);
  return environment ? summary(environment) : null;
}

export function getEnvironmentConfig(
  environmentId: EnvironmentId,
): AwsEnvironmentConfig | null {
  const environment = findEnvironment(environmentId);
  if (!environment) {
    return null;
  }

  const prefix = environmentPrefix(environment.id);
  const fileCredentials = parseCredentialsFile(
    credentialsPath(environment.credentialRef),
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
    id: environment.id,
    name: environment.name,
    regions: environment.regions,
    credentials: {
      accessKeyId,
      secretAccessKey,
      ...(sessionToken ? { sessionToken } : {}),
    },
  };
}
