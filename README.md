# QuickStage.dev Hosting Backend (Render + Cloudflare R2)

This backend lets you:
- Create a project (unique slug)
- Upload a ZIP of static files
- Serve the site from `https://<project>.quick-stage.app/` using a wildcard DNS record
- Verify DNS for custom domains (CNAME/A/AAAA) via DNS-over-HTTPS (“interrogation”)

## IMPORTANT SECURITY NOTE
If you pasted R2 keys/tokens anywhere (chat/screenshots), rotate them now.

## Cloudflare R2
You do **not** need to manually add anything to the bucket.
This backend uploads files into R2 for you.

You need:
- R2 bucket name
- Account ID
- R2 S3 Access Key ID + Secret Access Key

## DNS (Wildcard)
In Cloudflare DNS for `quick-stage.app` create:

- `CNAME`  `*`  ->  `<your-render-service>.onrender.com`   (proxy ON)

That makes every subdomain go to this backend.

## Render
Build command:
```
npm install
```

Start command:
```
npm start
```

Environment variables (Render > Environment):
Required:
- R2_ACCOUNT_ID
- R2_BUCKET
- R2_ACCESS_KEY_ID
- R2_SECRET_ACCESS_KEY

OAuth (required):
- OAUTH_ME_URL (your QuickStage OAuth “me” endpoint)
  - Example: https://quick-stage.app/api/auth/me

Optional:
- HOSTING_BASE_DOMAIN=quick-stage.app
- MAIN_HOSTS=quick-stage.app,www.quick-stage.app,quickstage.app,www.quickstage.app
- ALLOWED_ORIGINS=https://qsv8.pages.dev,https://quick-stage.app
- SPA_FALLBACK=true
- MAX_UPLOAD_MB=50

## API
### Create project
POST `/api/projects`
```json
{ "name": "Res", "desiredSlug": "res" }
```

### Upload zip
POST `/api/projects/:slug/upload`
multipart/form-data with field `file` (ZIP)

### DNS verify
GET `/api/domains/verify?domain=example.com`
