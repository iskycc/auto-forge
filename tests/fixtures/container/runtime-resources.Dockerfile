ARG NODE_IMAGE
FROM ${NODE_IMAGE}
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1
WORKDIR /app
COPY --chown=node:node . ./
RUN mkdir -p /var/lib/autoforge && chown node:node /var/lib/autoforge
USER node
CMD ["node", "apps/web/dist-server/server/index.js", "--data-dir=/var/lib/autoforge"]
