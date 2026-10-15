#!/bin/bash
# Defines what goes into the worker image. scripts/build-image.mjs runs this
# inside a worker's Box and then takes a snapshot of the result.
#
# Put slow, rarely changing things here. Keep app code and secrets out.
#
# Facts about a Box: Debian 12 on ARM64, user "boxuser" with passwordless sudo,
# Node, git and Claude Code already installed.
set -euo pipefail
export PATH=$HOME/.local/bin:$PATH

# The package files of the demo app were put in this folder by the build script.
# npm ci fills the npm cache (/tmp/.npm-cache) with every package of the app. The build
# script throws node_modules away afterwards, and the cache stays.
echo "--- npm cache of the demo app"
cd /workspace/home/.image-build/app
npm ci --silent

# More slow tools go here, for example a browser tool, a Python toolchain with
#   sudo apt-get install -y python3-venv python3-pip
# or an agent skill.

# The build log is the only evidence of what is in the image, and the build
# must fail when something is missing. List every tool the workers rely on.
echo "--- check"
node --version
npm --version
git --version
claude --version