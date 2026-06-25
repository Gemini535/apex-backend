import type { Request, Response } from 'express';
import { openapiSpec } from '../shared/openapi.js';

/**
 * Serves the raw OpenAPI 3.0 specification as JSON. This is the machine-readable
 * contract — tools like Swagger UI, Postman, and code generators consume it.
 */
export function docsJsonHandler(_req: Request, res: Response): void {
  res.setHeader('Content-Type', 'application/json');
  res.json(openapiSpec);
}

/**
 * Serves a self-contained, no-build-step Swagger UI page that loads the spec
 * from /api/docs.json. Uses the official CDN-hosted swagger-ui-dist so there's
 * no local asset to ship. In an air-gapped environment you'd vendor these
 * assets instead.
 */
export function docsUiHandler(_req: Request, res: Response): void {
  res.setHeader('Content-Type', 'text/html');
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Apex API Docs</title>
  <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css" />
  <style>body { margin: 0; } .topbar { display: none; }</style>
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
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
