import fs from 'node:fs';
import path from 'node:path';
import type { Express } from 'express';
import swaggerUi from 'swagger-ui-express';
import YAML from 'yaml';

function resolveOpenApiPath(): string {
  const cwd = path.join(process.cwd(), 'docs', 'openapi.yaml');
  if (fs.existsSync(cwd)) {
    return cwd;
  }

  const besideDist = path.join(__dirname, '..', '..', 'docs', 'openapi.yaml');
  if (fs.existsSync(besideDist)) {
    return besideDist;
  }

  throw new Error(
    'OpenAPI spec not found. Expected docs/openapi.yaml at project root (or beside dist when running compiled output).',
  );
}

/** Interactive docs at `GET /api-docs`. */
export function setupSwaggerUi(app: Express): void {
  const raw = fs.readFileSync(resolveOpenApiPath(), 'utf8');
  const spec = YAML.parse(raw) as Record<string, unknown>;

  app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(spec, { explorer: true }));
}
