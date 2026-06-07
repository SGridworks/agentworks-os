import React, { useState, useCallback, useMemo, useEffect } from 'react';
import clsx from 'clsx';
import {
  getSessionTimeline,
  getPolicyHitDetail,
  downloadSessionTimelineCsv,
  listInsights,
  TimelineEvent,
  TimelineEventType,
  TimelineEventSeverity,
  PolicyHitDetail,
  Insight,
  ListInsightsParams
} from '@/lib/api';
import {
  BoltIcon,
  ShieldIcon,
  FileTextIcon,
  DownloadIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  ClockIcon,
  LightbulbIcon,
  BookOpenIcon,
  FilterIcon,
  RefreshCw
} from 'lucide-react';
import { FilesTouchedPanel } from './files-touched-panel';

interface FlightRecorderTimelineProps {
  sessionId: string;
  tenantId?: string;
  className?: string;
  autoScroll?: boolean;
}

interface PolicyHitPopoverProps {
  hitId: string;
  tenantId?: string;
  children: React.ReactNode;
}

const ICONS: Record<TimelineEventType, React.ComponentType<{ className?: string }>> = {
  action: BoltIcon,
  policy: ShieldIcon,
  file: FileTextIcon,
};

const EVENT_TYPE_LABELS: Record<TimelineEventType, string> = {
  action: 'Action Proposed',
  policy: 'Policy Evaluated',
  file: 'File Operation',
};

// Simple date formatting function
function formatDate(date: Date, formatStr: string): string {
  if (formatStr === 'yyyy-MM-dd') {
    return date.toISOString().split('T')[0];
  }
  return date.toLocaleDateString();
}

const SEVERITY_COLORS: Record<TimelineEventSeverity, string> = {
  allow: 'text-success bg-success/10 border-success/20',
  route_to_review: 'text-warning bg-warning/10 border-warning/20',
  block: 'text-destructive bg-destructive/10 border-destructive/30',
  info: 'text-muted-foreground bg-muted/30 border-border',
  audit: 'text-muted-foreground bg-muted/30 border-border',
};

const SEVERITY_LABELS: Record<TimelineEventSeverity, string> = {
  allow: 'Allow',
  route_to_review: 'Review',
  block: 'Block',
  info: 'Info',
  audit: 'Audit',
};

function PolicyHitPopover({ hitId, tenantId, children }: PolicyHitPopoverProps) {
  const [open, setOpen] = useState(false);
  const [hitDetail, setHitDetail] = useState<PolicyHitDetail | null>(null);
  const [insights, setInsights] = useState<Insight[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'policy' | 'episode' | 'insights'>('policy');

  useEffect(() => {
    if (open && !hitDetail) {
      setIsLoading(true);
      setError(null);

      // Load policy hit details
      getPolicyHitDetail(hitId)
        .then(data => {
          setHitDetail(data);

          // Load related insights for this policy hit
          // Use the ruleId as subject to find related insights
          const insightsParams: ListInsightsParams = {
            tenantId: tenantId || 'default',
            subject: data.ruleId,
            limit: 5
          };

          return listInsights(insightsParams);
        })
        .then(insightsData => {
          setInsights(insightsData);
          setIsLoading(false);
        })
        .catch(err => {
          setError(err instanceof Error ? err.message : 'Failed to load policy details');
          setIsLoading(false);
        });
    }
  }, [open, hitId, hitDetail, tenantId]);

  const renderPolicyTab = () => (
    <div className="space-y-3">
      <div>
        <div className="text-sm font-medium text-card-foreground">Rule</div>
        <div className="text-sm text-muted-foreground font-mono">{hitDetail?.ruleId}</div>
      </div>
      <div>
        <div className="text-sm font-medium text-card-foreground">Pack</div>
        <div className="text-sm text-muted-foreground">
          {hitDetail?.packName}@{hitDetail?.packVersion}
        </div>
      </div>
      <div>
        <div className="text-sm font-medium text-card-foreground">Severity</div>
        <span className={clsx('text-xs px-2 py-1 rounded border', SEVERITY_COLORS[hitDetail?.severity as TimelineEventSeverity])}>
          {SEVERITY_LABELS[hitDetail?.severity as TimelineEventSeverity]}
        </span>
      </div>
      <div>
        <div className="text-sm font-medium text-card-foreground">Evidence</div>
        <div className="text-sm text-muted-foreground break-all font-mono">
          {hitDetail?.evidence && hitDetail.evidence.length > 200
            ? `${hitDetail.evidence.slice(0, 200)}...`
            : hitDetail?.evidence}
        </div>
      </div>
      <div className="pt-2 border-t border-border">
        <a
          href={hitDetail?.evidenceUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="text-sm text-info hover:underline"
        >
          View full evidence →
        </a>
      </div>
    </div>
  );

  const renderEpisodeTab = () => (
    <div className="space-y-3">
      <div className="text-center py-4">
        <BookOpenIcon className="h-8 w-8 text-muted-foreground mx-auto mb-2" />
        <div className="text-sm text-muted-foreground">
          Episode details will be loaded from the source session
        </div>
        <div className="text-xs text-muted-foreground mt-1">
          This policy decision was made during an agent execution session
        </div>
      </div>
      <div className="pt-2 border-t border-border">
        <div className="text-xs text-muted-foreground">
          The source episode contains the full context of the agent's reasoning and actions that led to this policy evaluation.
        </div>
      </div>
    </div>
  );

  const renderInsightsTab = () => (
    <div className="space-y-3">
      {insights.length > 0 ? (
        <div className="space-y-2">
          {insights.map((insight) => (
            <div key={insight.id} className="p-2 bg-muted/30 rounded border border-border">
              <div className="flex items-center gap-2 mb-1">
                <LightbulbIcon className="h-3 w-3 text-warning" />
                <span className="text-xs font-medium text-card-foreground capitalize">
                  {insight.frameType.replace('_', ' ')}
                </span>
                {insight.importance > 3 && (
                  <span className="text-xs px-1 py-0.5 bg-destructive/20 text-destructive rounded">
                    High
                  </span>
                )}
              </div>
              <div className="text-xs text-muted-foreground">
                {insight.content.length > 100
                  ? `${insight.content.slice(0, 100)}...`
                  : insight.content}
              </div>
              <div className="text-xs text-muted-foreground mt-1">
                Source: {insight.source.replace('_', ' ')} • {new Date(insight.createdAt).toLocaleDateString()}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="text-center py-4">
          <LightbulbIcon className="h-8 w-8 text-muted-foreground mx-auto mb-2" />
          <div className="text-sm text-muted-foreground">
            No related insights found
          </div>
          <div className="text-xs text-muted-foreground mt-1">
            Insights are generated from agent reflections and user corrections
          </div>
        </div>
      )}
    </div>
  );

  return (
    <div className="relative">
      <button
        onClick={(e) => {
          e.stopPropagation();
          setOpen(!open);
        }}
        className="btn btn-ghost btn-sm"
      >
        Why?
      </button>
      {open && (
        <div className="absolute z-50 top-full left-0 mt-1 w-96 bg-card border border-border rounded-lg shadow-lg">
          {/* Tab Navigation */}
          <div className="flex border-b border-border">
            <button
              onClick={() => setActiveTab('policy')}
              className={clsx(
                'flex-1 px-3 py-2 text-xs font-medium border-b-2 transition-colors',
                activeTab === 'policy'
                  ? 'text-card-foreground border-info'
                  : 'text-muted-foreground border-transparent hover:text-card-foreground'
              )}
            >
              <ShieldIcon className="h-3 w-3 inline mr-1" />
              Policy
            </button>
            <button
              onClick={() => setActiveTab('episode')}
              className={clsx(
                'flex-1 px-3 py-2 text-xs font-medium border-b-2 transition-colors',
                activeTab === 'episode'
                  ? 'text-card-foreground border-info'
                  : 'text-muted-foreground border-transparent hover:text-card-foreground'
              )}
            >
              <BookOpenIcon className="h-3 w-3 inline mr-1" />
              Episode
            </button>
            <button
              onClick={() => setActiveTab('insights')}
              className={clsx(
                'flex-1 px-3 py-2 text-xs font-medium border-b-2 transition-colors',
                activeTab === 'insights'
                  ? 'text-card-foreground border-info'
                  : 'text-muted-foreground border-transparent hover:text-card-foreground'
              )}
            >
              <LightbulbIcon className="h-3 w-3 inline mr-1" />
              Insights
            </button>
          </div>

          {/* Tab Content */}
          <div className="p-4">
            {isLoading && (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <ClockIcon className="h-4 w-4 animate-spin" />
                Loading details...
              </div>
            )}
            {error && (
              <div className="text-sm text-destructive">
                Failed to load details: {error}
              </div>
            )}
            {!isLoading && !error && (
              <>
                {activeTab === 'policy' && renderPolicyTab()}
                {activeTab === 'episode' && renderEpisodeTab()}
                {activeTab === 'insights' && renderInsightsTab()}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

interface TimelineRowProps {
  event: TimelineEvent;
  style: React.CSSProperties;
  tenantId?: string;
  index?: number;
  sessionId?: string;
}

function TimelineRow({ event, style, tenantId, index, sessionId }: TimelineRowProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const Icon = ICONS[event.type];

  const formattedTime = useMemo(() => {
    try {
      return new Date(event.timestamp).toLocaleTimeString('en-US', {
        hour12: false,
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        fractionalSecondDigits: 3
      });
    } catch {
      return event.timestamp;
    }
  }, [event.timestamp]);

  const handleToggleExpand = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setIsExpanded(prev => !prev);
  }, []);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault();
      setIsExpanded(prev => !prev);
    }
  }, []);

  const rowContent = (
    <div
      style={style}
      className={clsx(
        "flex items-start gap-3 p-3 border-b border-border hover:bg-accent/50 transition-colors cursor-pointer focus:outline-none focus:ring-2 focus:ring-info focus:ring-offset-2",
        isExpanded && "bg-accent/50"
      )}
      onClick={handleToggleExpand}
      onKeyDown={handleKeyDown}
      tabIndex={0}
      data-timeline-row={index}
      role="button"
      aria-expanded={isExpanded}
      aria-label={`${EVENT_TYPE_LABELS[event.type]} by ${event.actor} at ${formattedTime}`}
    >
      <div className="flex items-center gap-2 min-w-0 flex-1">
        <Icon className="h-4 w-4 text-muted-foreground flex-shrink-0" />
        <span className="text-xs text-muted-foreground font-mono flex-shrink-0">
          {formattedTime}
        </span>
        <span className="text-xs px-2 py-1 border border-border rounded font-mono flex-shrink-0">
          {event.actor}
        </span>
        <div className="flex flex-col min-w-0 flex-1">
          <span className="text-sm text-card-foreground truncate min-w-0">
            {EVENT_TYPE_LABELS[event.type]}: {event.summary}
          </span>
          {event.pack && (
            <span className="text-xs text-muted-foreground">
              {event.pack}
              {event.rule && ` • ${event.rule}`}
            </span>
          )}
          {event.filePath && (
            <span className="text-xs text-muted-foreground font-mono">
              {event.action} {event.filePath}
              {event.size && ` (${event.size} bytes)`}
            </span>
          )}
        </div>
      </div>

      {event.severity && (
        <span className={clsx('text-xs px-2 py-1 rounded border', SEVERITY_COLORS[event.severity])}>
          {SEVERITY_LABELS[event.severity]}
        </span>
      )}

      {event.hitId && (
        <PolicyHitPopover hitId={event.hitId} tenantId={tenantId}>
          <button className="btn btn-ghost btn-sm text-xs">
            Why?
          </button>
        </PolicyHitPopover>
      )}

      {event.payload && (
        <button className="btn btn-ghost btn-sm">
          {isExpanded ? (
            <ChevronDownIcon className="h-3 w-3" />
          ) : (
            <ChevronRightIcon className="h-3 w-3" />
          )}
        </button>
      )}
    </div>
  );

  return (
    <div>
      {rowContent}
      {isExpanded && event.payload && (
        <div className="px-3 pb-3 bg-accent/50 border-b border-border">
          <div className="ml-8 pl-5 border-l-2 border-border">
            {sessionId && (
              <div className="mb-2">
                <FilesTouchedPanel sessionId={sessionId} className="flex-1" />
              </div>
            )}
            <pre className="text-xs text-muted-foreground overflow-auto max-h-32 font-mono">
              {JSON.stringify(event.payload, null, 2)}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
}

export function FlightRecorderTimeline({ sessionId, tenantId, className, autoScroll = true }: FlightRecorderTimelineProps) {
  const [events, setEvents] = useState<TimelineEvent[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(true);
  const [showFilesPanel, setShowFilesPanel] = useState(false);
  const [eventFilter, setEventFilter] = useState<TimelineEventType | 'all'>('all');
  const [severityFilter, setSeverityFilter] = useState<TimelineEventSeverity | 'all'>('all');
  const [actorFilter, setActorFilter] = useState<string>('');
  const [isLive, setIsLive] = useState(true);

  // Fetch timeline data
  const fetchTimeline = useCallback(async (before?: string, after?: string) => {
    setIsLoading(true);
    setError(null);

    try {
      const response = await getSessionTimeline(sessionId, 50, before, after);
      const responseEvents = Array.isArray(response?.events) ? response.events : [];

      if (before) {
        // Prepend older events
        setEvents(prev => [...responseEvents, ...prev]);
      } else if (after) {
        // Append newer events
        setEvents(prev => [...prev, ...responseEvents]);
      } else {
        // Initial load
        setEvents(responseEvents);
      }

      setHasMore(responseEvents.length === 50);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load timeline');
    } finally {
      setIsLoading(false);
    }
  }, [sessionId]);

  // Filter events based on current filters
  const filteredEvents = useMemo(() => {
    return events.filter(event => {
      if (eventFilter !== 'all' && event.type !== eventFilter) return false;
      if (severityFilter !== 'all' && event.severity !== severityFilter) return false;
      if (actorFilter && !event.actor.toLowerCase().includes(actorFilter.toLowerCase())) return false;
      return true;
    });
  }, [events, eventFilter, severityFilter, actorFilter]);

  // Initial load and polling
  useEffect(() => {
    fetchTimeline();

    // Poll for new events every 2 seconds if live updates are enabled
    let interval: NodeJS.Timeout;
    if (isLive) {
      interval = setInterval(() => {
        if (events.length > 0) {
          const lastEvent = events[events.length - 1];
          fetchTimeline(undefined, lastEvent.timestamp);
        }
      }, 2000);
    }

    return () => {
      if (interval) clearInterval(interval);
    };
  }, [sessionId, fetchTimeline, events, isLive]);

  const handleLoadMore = useCallback(() => {
    if (events.length > 0 && !isLoading) {
      const firstEvent = events[0];
      fetchTimeline(firstEvent.timestamp);
    }
  }, [events, fetchTimeline, isLoading]);

  const handleExportCsv = useCallback(async () => {
    try {
      const blob = await downloadSessionTimelineCsv(sessionId);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `session_${sessionId}_${formatDate(new Date(), 'yyyy-MM-dd')}.csv`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to export CSV');
    }
  }, [sessionId]);

  // Keyboard navigation
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Only handle keyboard events when the timeline has focus
      const timelineElement = document.querySelector('[data-timeline-container]');
      if (!timelineElement || !timelineElement.contains(document.activeElement)) return;

      switch (e.key) {
        case 'ArrowUp':
          e.preventDefault();
          // Navigate to previous event
          break;
        case 'ArrowDown':
          e.preventDefault();
          // Navigate to next event
          break;
        case ' ':
          e.preventDefault();
          // Toggle expand/collapse of current event
          break;
        case 'Home':
          e.preventDefault();
          // Navigate to first event
          break;
        case 'End':
          e.preventDefault();
          // Navigate to last event
          break;
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, []);

  return (
    <div className={clsx("flex flex-col h-full", className)}>
      <div className="flex items-center justify-between p-4 border-b border-border bg-card">
        <div className="flex items-center gap-2">
          <ClockIcon className="h-5 w-5 text-muted-foreground" />
          <h3 className="text-lg font-semibold text-card-foreground">Flight Recorder</h3>
          <span className="text-xs px-2 py-1 border border-border rounded">
            {filteredEvents.length} of {events.length} events
          </span>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setIsLive(!isLive)}
            className={clsx(
              'btn btn-sm',
              isLive ? 'btn-primary' : 'btn-secondary'
            )}
            title={isLive ? 'Live updates enabled' : 'Live updates disabled'}
          >
            <RefreshCw className={clsx("h-4 w-4 mr-1", isLive && "animate-spin")} />
            {isLive ? 'Live' : 'Paused'}
          </button>
          <button
            onClick={() => setShowFilesPanel(!showFilesPanel)}
            className={clsx(
              'btn btn-sm',
              showFilesPanel ? 'btn-primary' : 'btn-secondary'
            )}
          >
            <FileTextIcon className="h-4 w-4 mr-1" />
            Files Touched
          </button>
          <button
            className="btn btn-secondary btn-sm"
            onClick={handleExportCsv}
            disabled={events.length === 0}
          >
            <DownloadIcon className="h-4 w-4 mr-2" />
            Export CSV
          </button>
        </div>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-4 p-4 border-b border-border bg-card">
        <div className="flex items-center gap-2">
          <FilterIcon className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm text-muted-foreground">Filter:</span>
        </div>

        <select
          value={eventFilter}
          onChange={(e) => setEventFilter(e.target.value as TimelineEventType | 'all')}
          className="text-sm border border-border rounded px-2 py-1 bg-background"
        >
          <option value="all">All Events</option>
          <option value="action">Actions</option>
          <option value="policy">Policy</option>
          <option value="file">Files</option>
        </select>

        <select
          value={severityFilter}
          onChange={(e) => setSeverityFilter(e.target.value as TimelineEventSeverity | 'all')}
          className="text-sm border border-border rounded px-2 py-1 bg-background"
        >
          <option value="all">All Severities</option>
          <option value="allow">Allow</option>
          <option value="route_to_review">Review</option>
          <option value="block">Block</option>
          <option value="info">Info</option>
          <option value="audit">Audit</option>
        </select>

        <input
          type="text"
          placeholder="Filter by actor..."
          value={actorFilter}
          onChange={(e) => setActorFilter(e.target.value)}
          className="text-sm border border-border rounded px-2 py-1 bg-background"
        />
      </div>

      <div className="flex-1 flex gap-4 overflow-hidden p-4">
        <div className={clsx(
          "flex flex-col transition-all duration-300",
          showFilesPanel ? "w-1/2" : "w-full"
        )}>
          <div className="flex-1 overflow-auto card border border-border rounded-lg" data-timeline-container tabIndex={0}>
            <div className="divide-y divide-border">
              {filteredEvents.map((event, index) => (
                <TimelineRow
                  key={`${event.timestamp}-${event.type}-${event.id}`}
                  event={event}
                  style={{}}
                  tenantId={tenantId}
                  index={index}
                  sessionId={sessionId}
                />
              ))}
            </div>

            {hasMore && (
              <div className="p-4 text-center">
                <button
                  className="btn btn-secondary btn-sm"
                  onClick={handleLoadMore}
                  disabled={isLoading}
                >
                  {isLoading ? 'Loading...' : 'Load More'}
                </button>
              </div>
            )}

            {filteredEvents.length === 0 && !isLoading && (
              <div className="p-8 text-center text-muted-foreground">
                {events.length === 0 ? 'No events recorded for this session' : 'No events match current filters'}
              </div>
            )}

            {error && (
              <div className="p-4 m-4 bg-destructive/10 border border-destructive/30 rounded-md">
                <div className="text-sm text-destructive">{error}</div>
              </div>
            )}
          </div>
        </div>

        {showFilesPanel && (
          <div className="w-1/2 flex flex-col">
            <FilesTouchedPanel sessionId={sessionId} className="flex-1" />
          </div>
        )}
      </div>
    </div>
  );
}
