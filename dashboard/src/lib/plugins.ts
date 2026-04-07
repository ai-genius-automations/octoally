export interface PluginPanel {
  id: string;
  title: string;
  path: string;
}

export interface PluginManifest {
  name: string;
  displayName: string;
  icon?: string;
  panels: PluginPanel[];
}

export async function loadPluginManifests(): Promise<PluginManifest[]> {
  try {
    const resp = await fetch('/api/plugins/manifests');
    if (!resp.ok) return [];
    return await resp.json();
  } catch {
    return [];
  }
}
