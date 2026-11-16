# SPDX-License-Identifier: AGPL-3.0-only
# The agents' egress filter (see proxy.mjs). No dependencies beyond Node itself.
FROM node:24-slim
COPY proxy.mjs /proxy.mjs
USER node
EXPOSE 3128
CMD ["node", "/proxy.mjs"]
