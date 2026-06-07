import React, { useState, useEffect, useCallback } from 'react';
import clsx from 'clsx';
import { getSessionFileAccess, FileAccessEntry } from '@/lib/api';
import { FileTextIcon, DownloadIcon, ClockIcon } from 'lucide-react';

interface FilesTouchedPanelProps {
  sessionId: string;
  className?: string;
}

const OP_COLORS: Record<string, string> = {
  read: 'text-info bg-info/10 border-info/20',
  write: 'text-warning bg-warning/10 border-warning/20',
  create: 'text-success bg-success/10 border-success/20',
  delete: 'text-destructive bg-destructive/10 border-destructive/30',
};

const OP_LABELS: Record<string, string> = {
  read: 'Read',
  write: 'Write',
  create: 'Create',
  delete: 'Delete',
};

// Simple date formatting function
function formatDate(date: Date, formatStr: string): string {
  if (formatStr === 'yyyy-MM-dd') {
    return date.toISOString().split('T')[0];
  }
  return date.toLocaleDateString();
}

// Simple time formatting function
function formatTime(dateStr: string): string {
  try {
    const date = new Date(dateStr);
    return date.toLocaleTimeString('en-US', {
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });
  } catch {
    return dateStr;
  }
}

function groupFilesByDirectory(files: FileAccessEntry[]): Map<string, FileAccessEntry[]> {
  const groups = new Map<string, FileAccessEntry[]>();

  files.forEach(file => {
    const dir = file.filePath.substring(0, file.filePath.lastIndexOf('/')) || '/';
    if (!groups.has(dir)) {
      groups.set(dir, []);
    }
    groups.get(dir)!.push(file);
  });

  return groups;
}

function formatFileSize(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

export function FilesTouchedPanel({ sessionId, className }: FilesTouchedPanelProps) {
  const [files, setFiles] = useState<FileAccessEntry[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [groupByDirectory, setGroupByDirectory] = useState(true);

  useEffect(() => {
    const fetchFileAccess = async () => {
      setIsLoading(true);
      setError(null);

      try {
        const response = await getSessionFileAccess(sessionId);
        setFiles(response.entries);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load file access data');
      } finally {
        setIsLoading(false);
      }
    };

    if (sessionId) {
      fetchFileAccess();
    }
  }, [sessionId]);

  const handleExportCsv = useCallback(async () => {
    if (files.length === 0) return;

    const csvContent = [
      'Timestamp,File Path,Operation,Agent ID',
      ...files.map(file =>
        `${file.createdAt},${file.filePath},${file.op},${file.agentId}`
      )
    ].join('\n');

    const blob = new Blob([csvContent], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `session_${sessionId}_files_${formatDate(new Date(), 'yyyy-MM-dd')}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, [files, sessionId]);

  const fileGroups = groupByDirectory ? groupFilesByDirectory(files) : new Map();
  const totalFiles = files.length;
  const uniqueFiles = new Set(files.map(f => f.filePath)).size;

  if (isLoading) {
    return (
      <div className={clsx("card flex flex-col h-full", className)}>
        <div className="p-4 border-b border-border">
          <div className="flex items-center gap-2">
            <FileTextIcon className="h-5 w-5 text-muted-foreground" />
            <h3 className="text-lg font-semibold text-card-foreground">Files Touched</h3>
          </div>
        </div>
        <div className="flex-1 flex items-center justify-center">
          <div className="text-muted-foreground">Loading file access data...</div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className={clsx("card flex flex-col h-full", className)}>
        <div className="p-4 border-b border-border">
          <div className="flex items-center gap-2">
            <FileTextIcon className="h-5 w-5 text-muted-foreground" />
            <h3 className="text-lg font-semibold text-card-foreground">Files Touched</h3>
          </div>
        </div>
        <div className="flex-1 flex items-center justify-center">
          <div className="text-destructive">{error}</div>
        </div>
      </div>
    );
  }

  return (
    <div className={clsx("card flex flex-col h-full", className)}>
      <div className="flex items-center justify-between p-4 border-b border-border">
        <div className="flex items-center gap-2">
          <FileTextIcon className="h-5 w-5 text-muted-foreground" />
          <h3 className="text-lg font-semibold text-card-foreground">Files Touched</h3>
          <span className="text-xs px-2 py-1 border border-border rounded">
            {totalFiles} accesses, {uniqueFiles} unique
          </span>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setGroupByDirectory(!groupByDirectory)}
            className={clsx(
              'btn btn-sm',
              groupByDirectory ? 'btn-primary' : 'btn-secondary'
            )}
          >
            Group by Directory
          </button>
          <button
            className="btn btn-secondary btn-sm"
            onClick={handleExportCsv}
            disabled={files.length === 0}
          >
            <DownloadIcon className="h-4 w-4 mr-2" />
            Export CSV
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-auto">
        {files.length === 0 ? (
          <div className="p-8 text-center text-muted-foreground">
            No files accessed during this session
          </div>
        ) : (
          <div className="divide-y divide-border">
            {groupByDirectory ? (
              Array.from(fileGroups.entries()).map(([directory, dirFiles]) => (
                <div key={directory} className="p-3">
                  <div className="text-sm font-medium text-card-foreground mb-2">
                    {directory}
                  </div>
                  <div className="space-y-1 ml-4">
                    {(dirFiles as FileAccessEntry[]).map((file) => (
                      <FileAccessRow key={file.id} file={file} />
                    ))}
                  </div>
                </div>
              ))
            ) : (
              files.map((file) => (
                <FileAccessRow key={file.id} file={file} />
              ))
            )}
          </div>
        )}
      </div>
    </div>
  );
}

interface FileAccessRowProps {
  file: FileAccessEntry;
}

function FileAccessRow({ file }: FileAccessRowProps) {
  const fileName = file.filePath.split('/').pop() || file.filePath;
  const formattedTime = formatTime(file.createdAt);

  return (
    <div className="flex items-center gap-3 py-2 hover:bg-accent/50 transition-colors rounded px-2">
      <div className="flex items-center gap-2 flex-1 min-w-0">
        <span className={clsx('text-xs px-2 py-1 rounded border', OP_COLORS[file.op])}>
          {OP_LABELS[file.op]}
        </span>
        <span className="text-sm text-card-foreground truncate" title={file.filePath}>
          {fileName}
        </span>
      </div>
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <ClockIcon className="h-3 w-3" />
        {formattedTime}
      </div>
    </div>
  );
}
