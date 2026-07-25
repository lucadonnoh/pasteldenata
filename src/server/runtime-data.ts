import { resolve } from "node:path";

/**
 * Railway exposes an attached volume through RAILWAY_VOLUME_MOUNT_PATH.
 * Local development deliberately falls back to the repository root so the
 * existing ignored files keep working without extra setup.
 */
export function runtimeDataDirectory(
  environment: NodeJS.ProcessEnv = process.env,
  workingDirectory = process.cwd(),
): string {
  const configured =
    environment.PASTEL_DATA_DIR?.trim() ||
    environment.RAILWAY_VOLUME_MOUNT_PATH?.trim();
  return resolve(configured || workingDirectory);
}
