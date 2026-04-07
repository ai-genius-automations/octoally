export interface SkillItem {
  id: string;
  name: string;
  category: string;
  command: string;
  scope: 'global' | 'project';
  description?: string;
}

export interface SystemFeature {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  status: 'ok' | 'error' | 'degraded' | 'unknown';
  lastChecked?: number;
  details?: Record<string, string>;
}

export interface Integration {
  id: string;
  name: string;
  connected: boolean;
  status: 'ok' | 'error' | 'degraded' | 'unknown';
  details?: Record<string, string>;
}
