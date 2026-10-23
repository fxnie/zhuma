/**
 * Call sites the legacy owner gate must reach only after
 * `authorizeLegacyOwnerRoutes` allows the request.
 * `zhuma_asset_packages` stores immutable bytes and does not authorize them.
 */
import { previewResourcePackage } from '@zhuma/agent-core';
import { previewAssetImport } from './asset-import.js';

export const legacyRouteEffects = {
  previewAssetImport,
  previewResourcePackage,
};
