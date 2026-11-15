import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";



export const PDF_STAGING_DIR = ".opencode-muse-uploads";

export type StagePdfOutcome = { ok: true; path: string } | { ok: false; code: "pdf-stage-failed" };


export type StagePdfAttachment = (bytes: Uint8Array) => Promise<StagePdfOutcome>;

export interface PdfFileSystem {
  mkdir(path: string, opts?: { recursive?: boolean }): Promise<unknown>;
  writeFile(path: string, data: Uint8Array): Promise<void>;
  chmod(path: string, mode: number): Promise<void>;
  rm(path: string, opts?: { recursive?: boolean; force?: boolean }): Promise<void>;
}

const defaultFs: PdfFileSystem = { mkdir, writeFile, chmod, rm };

export function pdfStagingDir(workspaceDir: string): string {
  return join(workspaceDir, PDF_STAGING_DIR);
}

export function createPdfStager(workspaceDir: string, fs: PdfFileSystem = defaultFs): StagePdfAttachment {
  const directory = pdfStagingDir(workspaceDir);
  return async (bytes) => {
    try {
      await fs.mkdir(directory, { recursive: true });
      const path = join(directory, `${randomUUID()}.pdf`);
      await fs.writeFile(path, bytes);
      
      
      await fs.chmod(path, 0o444).catch(() => {});
      return { ok: true, path };
    } catch {
      return { ok: false, code: "pdf-stage-failed" };
    }
  };
}


export async function purgePdfStaging(workspaceDir: string, fs: PdfFileSystem = defaultFs): Promise<void> {
  try {
    await fs.rm(pdfStagingDir(workspaceDir), { recursive: true, force: true });
  } catch {
    
  }
}
