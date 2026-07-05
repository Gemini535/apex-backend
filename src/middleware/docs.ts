import type { Request, Response } from 'express';
import { openapiSpec } from '../shared/openapi.js';

/**
 * Docs are public (no auth) by design — they're meant to be linked to
 * partners/mobile devs. In production that means the entire API surface
 * (routes, schemas) is discoverable by anyone who finds the URL
 * (CODE_REVIEW.md #29). Default to OFF in production; operators who
 * genuinely want public docs there can opt in explicitly.
 */
function docsEnabled(): boolean {
  if (process.env.NODE_ENV !== 'production') return true;
  return process.env.ENABLE_PUBLIC_DOCS === 'true';
}

function notFound(res: Response): void {
  res.status(404).json({ error: 'Route not found' });
}

/**
 * Serves the raw OpenAPI 3.0 specification as JSON. This is the machine-readable
 * contract — tools like Swagger UI, Postman, and code generators consume it.
 */
export function docsJsonHandler(_req: Request, res: Response): void {
  if (!docsEnabled()) {
    notFound(res);
    return;
  }
  res.setHeader('Content-Type', 'application/json');
  res.json(openapiSpec);
}

/**
 * Serves a self-contained, no-build-step Swagger UI page that loads the spec
 * from /api/docs.json. Uses the official CDN-hosted swagger-ui-dist so there's
 * no local asset to ship. In an air-gapped environment you'd vendor these
 * assets instead.
 *
 * The CDN assets are pinned to an exact version (not a floating `@5` major
 * tag) so the served script/stylesheet can't silently change out from under
 * us. We deliberately do NOT attach fabricated `integrity` (SRI) hashes here
 * — a wrong hash fails closed (the browser refuses to execute the script at
 * all) and there's no way to verify a real hash for a pinned version without
 * network access. If you keep this page public, generate real hashes before
 * shipping, e.g.:
 *   curl -s https://unpkg.com/swagger-ui-dist@5.17.14/swagger-ui-bundle.js | openssl dgst -sha384 -binary | openssl base64 -A
 * and add `integrity="sha384-<hash>" crossorigin="anonymous"` to each tag
 * (CODE_REVIEW.md #29).
 */
export function docsUiHandler(_req: Request, res: Response): void {
  if (!docsEnabled()) {
    notFound(res);
    return;
  }
  res.setHeader('Content-Type', 'text/html');
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Apex API Docs</title>
  <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5.17.14/swagger-ui.css" />
  <style>body { margin: 0; } .topbar { display: none; }</style>
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="https://unpkg.com/swagger-ui-dist@5.17.14/swagger-ui-bundle.js"></script>
  <script>
    window.ui = SwaggerUIBundle({
      url: '/api/docs.json',
      dom_id: '#swagger-ui',
      deepLinking: true,
      presets: [SwaggerUIBundle.presets.apis],
      layout: 'BaseLayout',
    });
  </script>
</body>
</html>`);
}
