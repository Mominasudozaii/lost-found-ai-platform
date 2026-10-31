# Recoverly — AI-Powered Lost & Found Platform

Recoverly is a complete full-stack starter for an intelligent lost-and-found service. It uses **Neon PostgreSQL** for persistent cloud data and provides a responsive web experience for reporting, searching, matching, and privately messaging about belongings.

## Included features

- Account registration, sign-in, sign-out, and profile editing with bcrypt password hashes and signed, HTTP-only session cookies.
- Lost and found reports with category, description, keywords, optional date/time, optional WhatsApp number, landmark, optional coordinates, and up to five images.
- Browse/search/filter across reports; optional radius search through the browser's location permission.
- Smart lost-versus-found recommendations that weigh category, description keywords, color, location, and visual similarity. Each recommendation carries an explainable percentage score.
- Image search based on a private perceptual hash. The uploaded search image is processed in memory and is not stored.
- AI-style natural-language search assistant that extracts meaningful terms, searches the platform database, and recommends ranked reports. It works without sending personal data to an external LLM.
- Private item conversations and in-app notifications; contact details are not exposed in public cards or details.
- Meta Graph API adapter for authorized Instagram Business/Creator media and Facebook Page posts, with result caching in Neon.
- Neon schema for users, item reports, images, chats, messages, notifications, and social search results.

## Run it

1. Install **Node.js 20+**.
2. In this folder, make a `.env` file from `.env.example`.
3. Put your pooled Neon connection string in `DATABASE_URL` and set a long random `JWT_SECRET`.
4. Run:

   ```bash
   npm install
   npm start
   ```

5. Visit [http://localhost:3000](http://localhost:3000).

The server applies `sql/schema.sql` at startup, so an empty Neon database needs no separate migration command.

## Optional Meta setup

The social endpoint is intentionally truthful about Meta platform limits: Meta does **not** allow arbitrary search across every public Facebook or Instagram post. When supplied with a permitted app token plus `META_IG_USER_ID` and/or `META_FACEBOOK_PAGE_ID`, Recoverly searches media the connected Business/Creator account or Page is authorized to read, then filters it by the user's item query.

Set these optional `.env` values after configuring your Meta app and the required permissions:

```dotenv
META_ACCESS_TOKEN=...
META_IG_USER_ID=...
META_FACEBOOK_PAGE_ID=...
META_API_VERSION=v21.0
```

## Folder structure

```text
lost-found-ai-platform/
├── public/
│   ├── app.js             # Single-page UI behavior
│   ├── index.html         # Responsive dashboard
│   └── style.css          # Responsive visual system
├── src/
│   ├── db.js              # Neon PostgreSQL pool and schema bootstrap
│   ├── server.js          # Express REST API, auth, uploads, chat
│   └── services/
│       ├── matching.js    # Explainable text/location recommendation scores
│       ├── social.js      # Authorized Meta Graph adapter
│       └── vision.js      # Perceptual image hashing and comparison
├── sql/
│   └── schema.sql         # Neon database schema
├── .env.example           # Environment variable template
├── .gitignore
└── package.json
```

## Security notes

- Never commit `.env`; it is ignored by Git.
- Change `JWT_SECRET` before production and use HTTPS (`NODE_ENV=production`) when deployed.
- Public item cards do not disclose email, WhatsApp, or passwords. Use private conversation requests to coordinate recovery.
- Uploads accept JPEG, PNG, and WebP only, with a 5 MB limit per image.
- A production deployment should place image uploads in object storage (for example Cloudflare R2, S3, or Vercel Blob) instead of the local `uploads/` folder.

## API overview

| Area | Endpoints |
| --- | --- |
| Auth and profile | `POST /api/auth/signup`, `POST /api/auth/login`, `POST /api/auth/logout`, `GET/PUT /api/me` |
| Reports | `GET/POST /api/items`, `GET /api/items/:id`, `PATCH /api/items/:id/status`, `DELETE /api/items/:id` |
| Intelligent search | `GET /api/items/:id/matches`, `POST /api/assistant`, `POST /api/visual-search` |
| Chat and notifications | `POST/GET /api/conversations`, `GET/POST /api/conversations/:id/messages`, `GET /api/notifications` |
| Integrations | `POST /api/social/search`, `GET /api/stats`, `GET /api/categories` |
