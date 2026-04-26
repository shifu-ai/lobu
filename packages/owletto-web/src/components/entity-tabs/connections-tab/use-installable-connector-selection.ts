import { useCallback, useState } from 'react';
import type { ConnectorDefinitionItem } from '@/lib/api';

interface UseInstallableConnectorSelectionParams {
  isInstalling: boolean;
  installConnectorFromSourceUri: (sourceUri: string) => Promise<void>;
  reloadConnectorCatalog: () => Promise<ConnectorDefinitionItem[]>;
  resetConnectorConfiguration: () => void;
  selectConnector: (connector: ConnectorDefinitionItem) => void;
  clearSaveError: () => void;
  setInstallError: (error: string | null) => void;
}

export function useInstallableConnectorSelection({
  isInstalling,
  installConnectorFromSourceUri,
  reloadConnectorCatalog,
  resetConnectorConfiguration,
  selectConnector,
  clearSaveError,
  setInstallError,
}: UseInstallableConnectorSelectionParams) {
  const [installingConnectorKey, setInstallingConnectorKey] = useState<string | null>(null);
  const [previewConnector, setPreviewConnector] = useState<ConnectorDefinitionItem | null>(null);

  const handleConnectorSelect = useCallback(
    async (connector: ConnectorDefinitionItem) => {
      if (isInstalling) return;

      setInstallError(null);
      clearSaveError();

      // Uninstalled connector → show preview first
      if (connector.installed === false && connector.installable) {
        setPreviewConnector(connector);
        return;
      }

      // Already installed → go straight to configuration
      selectConnector(connector);
      resetConnectorConfiguration();
    },
    [clearSaveError, isInstalling, resetConnectorConfiguration, selectConnector, setInstallError]
  );

  const handleInstallPreviewedConnector = useCallback(async () => {
    if (!previewConnector || isInstalling) return;

    if (!previewConnector.source_uri) {
      setInstallError(`Connector '${previewConnector.name}' is missing a source URI.`);
      return;
    }

    setInstallingConnectorKey(previewConnector.key);
    try {
      await installConnectorFromSourceUri(previewConnector.source_uri);
      const refreshedCatalog = await reloadConnectorCatalog();
      const installedConnector =
        refreshedCatalog.find(
          (item) => item.key === previewConnector.key && item.installed !== false
        ) ?? null;

      if (!installedConnector) {
        throw new Error(`Installed connector '${previewConnector.name}' could not be reloaded.`);
      }

      setPreviewConnector(null);
      selectConnector(installedConnector);
      resetConnectorConfiguration();
    } catch (error) {
      setInstallError(error instanceof Error ? error.message : 'Failed to install connector');
    } finally {
      setInstallingConnectorKey(null);
    }
  }, [
    installConnectorFromSourceUri,
    isInstalling,
    previewConnector,
    reloadConnectorCatalog,
    resetConnectorConfiguration,
    selectConnector,
    setInstallError,
  ]);

  const clearPreview = useCallback(() => {
    setPreviewConnector(null);
    setInstallError(null);
  }, [setInstallError]);

  return {
    installingConnectorKey,
    setInstallingConnectorKey,
    previewConnector,
    handleConnectorSelect,
    handleInstallPreviewedConnector,
    clearPreview,
  };
}
