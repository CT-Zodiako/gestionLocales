FROM node:24-alpine
RUN npm install -g pnpm@12.6.0
WORKDIR /app

# Install only what the API needs, using the workspace lockfile.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY apps/api/package.json apps/api/
COPY packages/db/package.json packages/db/
COPY packages/shared/package.json packages/shared/
RUN pnpm install --frozen-lockfile --prod --filter @gestion/api...

COPY packages/db packages/db
COPY packages/shared packages/shared
COPY apps/api/src apps/api/src

ENV NODE_ENV=production PORT=3000
EXPOSE 3000
USER node
# Node 24 runs TypeScript directly (type stripping), so there is no build step.
CMD ["node", "apps/api/src/index.ts"]
