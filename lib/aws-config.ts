import { existsSync, readFileSync } from "node:fs";
import type { EnvironmentId, EnvironmentSummary } from "./cloudboard";

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

interface AwsEnvironmentDefinition {
  id: EnvironmentId;
  name: string;
  group: string;
  regions: string[];
  credentialsFile: string | null;
  credentialsEnvPrefix: string;
}

const environmentIdPattern = /^[a-z0-9][a-z0-9-]{0,62}$/;
const environmentPrefixPattern = /^[A-Z][A-Z0-9_]{0,63}$/;
const defaultRegions = ["ap-northeast-2"];

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function cleanText(value: unknown, fallback: string, maxLength = 80) {
  return typeof value === "string" && value.trim()
    ? value.trim().slice(0, maxLength)
    : fallback;
}

function parseRegions(value: unknown) {
  const regions = (
    Array.isArray(value)
      ? value
      : typeof value === "string"
        ? value.split(",")
        : defaultRegions
  )
    .filter((region): region is string => typeof region === "string")
    .map((region) => region.trim())
    .filter((region) => /^[a-z0-9-]{3,32}$/.test(region));

  const uniqueRegions = [...new Set(regions)].slice(0, 10);
  return uniqueRegions.length > 0 ? uniqueRegions : defaultRegions;
}

function normalizeEnvironment(
  value: unknown,
  index: number,
): AwsEnvironmentDefinition {
  const input = asRecord(value);
  if (!input) {
    throw new Error(`Environment at index ${index} must be an object.`);
  }

  const id = cleanText(input.id, "").toLowerCase();
  if (!environmentIdPattern.test(id)) {
    throw new Error(`Environment at index ${index} has an invalid id.`);
  }

  const defaultPrefix = `AWS_${id.replaceAll("-", "_").toUpperCase()}`;
  const credentialsEnvPrefix = cleanText(
    input.credentialsEnvPrefix,
    defaultPrefix,
    64,
  );
  if (!environmentPrefixPattern.test(credentialsEnvPrefix)) {
    throw new Error(`Environment ${id} has an invalid credentialsEnvPrefix.`);
  }

  const credentialsFile =
    typeof input.credentialsFile === "string" && input.credentialsFile.trim()
      ? input.credentialsFile.trim()
      : null;

  return {
    id,
    name: cleanText(input.name, id, 80),
    group: cleanText(input.group, "General", 40),
    regions: parseRegions(input.regions),
    credentialsFile,
    credentialsEnvPrefix,
  };
}

function legacyEnvironmentDefinitions(): AwsEnvironmentDefinition[] {
  return [
    {
      id: "dev",
      name: process.env.AWS_DEV_NAME?.trim() || "Development",
      group: "Default",
      regions: parseRegions(process.env.AWS_DEV_REGIONS),
      credentialsFile:
        process.env.AWS_DEV_CREDENTIALS_FILE?.trim() || null,
      credentialsEnvPrefix: "AWS_DEV",
    },
    {
      id: "prd",
      name: process.env.AWS_PRD_NAME?.trim() || "Production",
      group: "Default",
      regions: parseRegions(process.env.AWS_PRD_REGIONS),
      credentialsFile:
        process.env.AWS_PRD_CREDENTIALS_FILE?.trim() || null,
      credentialsEnvPrefix: "AWS_PRD",
    },
  ];
}

function parseEnvironmentSource(source: string) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw new Error("CloudBoard environments configuration is not valid JSON.");
  }

  const root = asRecord(parsed);
  const values = Array.isArray(parsed)
    ? parsed
    : root && Array.isArray(root.environments)
      ? root.environments
      : null;
  if (!values || values.length === 0) {
    throw new Error(
      "CloudBoard environments configuration must contain at least one environment.",
    );
  }

  const definitions = values.map(normalizeEnvironment);
  const ids = new Set<string>();
  for (const definition of definitions) {
    if (ids.has(definition.id)) {
      throw new Error(`Environment id ${definition.id} is duplicated.`);
    }
    ids.add(definition.id);
  }
  return definitions;
}

function getEnvironmentDefinitions() {
  const inlineConfig = process.env.CLOUDBOARD_ENVIRONMENTS_JSON?.trim();
  if (inlineConfig) {
    return parseEnvironmentSource(inlineConfig);
  }

  const configFile = process.env.CLOUDBOARD_ENVIRONMENTS_FILE?.trim();
  if (configFile) {
    if (!existsSync(configFile)) {
      throw new Error("CloudBoard environments configuration file was not found.");
    }
    return parseEnvironmentSource(readFileSync(configFile, "utf8"));
  }

  return legacyEnvironmentDefinitions();
}

function configured(definition: AwsEnvironmentDefinition) {
  const prefix = definition.credentialsEnvPrefix;
  const hasEnvironmentCredentials = Boolean(
    process.env[`${prefix}_ACCESS_KEY_ID`]?.trim() &&
      process.env[`${prefix}_SECRET_ACCESS_KEY`]?.trim(),
  );
  const credentialsFile =
    process.env[`${prefix}_CREDENTIALS_FILE`]?.trim() ??
    definition.credentialsFile;

  return (
    hasEnvironmentCredentials ||
    Boolean(credentialsFile && existsSync(credentialsFile))
  );
}

function parseCredentialsFile(path: string | null) {
  if (!path || !existsSync(path)) {
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

export function getEnvironmentSummaries(): EnvironmentSummary[] {
  return getEnvironmentDefinitions().map((definition) => ({
    id: definition.id,
    name: definition.name,
    group: definition.group,
    regions: definition.regions,
    configured: configured(definition),
  }));
}

export function getEnvironmentSummary(
  environmentId: string,
): EnvironmentSummary | null {
  return (
    getEnvironmentSummaries().find(
      (environment) => environment.id === environmentId,
    ) ?? null
  );
}

export function getEnvironmentConfig(
  environmentId: EnvironmentId,
): AwsEnvironmentConfig | null {
  const definition = getEnvironmentDefinitions().find(
    (environment) => environment.id === environmentId,
  );
  if (!definition) {
    return null;
  }

  const prefix = definition.credentialsEnvPrefix;
  const fileCredentials = parseCredentialsFile(
    process.env[`${prefix}_CREDENTIALS_FILE`]?.trim() ??
      definition.credentialsFile,
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
    id: definition.id,
    name: definition.name,
    regions: definition.regions,
    credentials: {
      accessKeyId,
      secretAccessKey,
      ...(sessionToken ? { sessionToken } : {}),
    },
  };
}
