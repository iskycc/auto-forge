#!/usr/bin/env bash
set -Eeuo pipefail

readonly destination="${1:?verified dependency directory is required}"
mkdir -p -- "${destination}"
export AUTOFORGE_ACCEPTANCE_DEPENDENCY_CACHE="${destination}"
for dependency in \
  '461252831 f3d0c820c749f81d717310fb00d4903919e70e3e66b268bd352a088b9788eb93 nats-io/nats-server nats.tar.gz' \
  '404660713 53e2a2cb16c5366ea6fbbc479c19ddb4c6a0948273e752f740fb1fbf27bb817c minio/minio minio'; do
  read -r asset digest repository filename <<< "${dependency}"
  bash scripts/quality/download-acceptance-dependency.sh \
    "https://api.github.com/repos/${repository}/releases/assets/${asset}" \
    "${digest}" "${destination}/${filename}"
  # Only content-addressed copies are shared. Consumers recheck their pinned digest.
  rm -- "${destination}/${filename}"
done
