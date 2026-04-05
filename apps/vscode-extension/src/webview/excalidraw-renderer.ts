import { exportToSvg } from '@excalidraw/utils';

(window as unknown as Record<string, unknown>).__kiviExcalidrawExportToSvg = exportToSvg;
