'use client';

import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { Search, X, CornerDownLeft } from 'lucide-react';
import clsx from 'clsx';

export interface ActionRegistryItem {
  id: string;
  verb: string;
  noun: string;
  description: string;
  icon: string;
  scope: 'global' | 'tenant' | 'page';
  page?: string;
  handler: string | (() => void);
  dangerous?: boolean;
  shortcut?: string[];
  keywords?: string[];
}

interface CommandPaletteProps {
  isOpen: boolean;
  onClose: () => void;
  onSelect: (item: ActionRegistryItem) => void;
  registry?: ActionRegistryItem[];
  currentPage?: string;
  onQueryChange?: (query: string) => void;
}

interface GroupedActions {
  recent: ActionRegistryItem[];
  global: ActionRegistryItem[];
  contextual: ActionRegistryItem[];
  infrequent: ActionRegistryItem[];
}

function scoreAction(action: ActionRegistryItem, query: string): number {
  if (!query) return 1;
  
  const tokens = query.toLowerCase().split(' ').filter(Boolean);
  let score = 0;
  
  for (const token of tokens) {
    const verbLower = action.verb.toLowerCase();
    const nounLower = action.noun.toLowerCase();
    const descriptionLower = action.description.toLowerCase();
    
    if (verbLower.startsWith(token)) score += 10;
    if (nounLower.startsWith(token)) score += 8;
    if (descriptionLower.includes(token)) score += 5;
    
    if (action.keywords) {
      for (const keyword of action.keywords) {
        if (keyword.toLowerCase().includes(token)) score += 5;
      }
    }
  }
  
  return score;
}

function groupActions(actions: ActionRegistryItem[], currentPage?: string): GroupedActions {
  const grouped: GroupedActions = {
    recent: [],
    global: [],
    contextual: [],
    infrequent: [],
  };
  
  for (const action of actions) {
    if (action.scope === 'global') {
      grouped.global.push(action);
    } else if (action.scope === 'page' && action.page && currentPage) {
      // Simple regex matching for page scope
      const pageRegex = new RegExp(action.page);
      if (pageRegex.test(currentPage)) {
        grouped.contextual.push(action);
      } else {
        grouped.infrequent.push(action);
      }
    } else {
      grouped.infrequent.push(action);
    }
  }
  
  // Sort infrequent alphabetically
  grouped.infrequent.sort((a, b) => a.verb.localeCompare(b.verb));
  
  return grouped;
}

export function CommandPalette({ isOpen, onClose, onSelect, registry = [], currentPage, onQueryChange }: CommandPaletteProps) {
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [recentIds, setRecentIds] = useState<string[]>([]);

  // Load recent actions from localStorage on mount
  useEffect(() => {
    try {
      const stored = localStorage.getItem('command-palette-recent');
      if (stored) {
        const parsed = JSON.parse(stored);
        if (Array.isArray(parsed)) {
          setRecentIds(parsed);
        }
      }
    } catch {
      // Ignore localStorage errors
    }
  }, []);

  // Filter and score actions based on query
  const filteredActions = useMemo(() => {
    const scored = registry.map(action => ({
      action,
      score: scoreAction(action, query),
    }));
    
    const filtered = scored.filter(item => item.score > 0);
    filtered.sort((a, b) => {
      if (a.score !== b.score) return b.score - a.score;
      return a.action.verb.localeCompare(b.action.verb);
    });
    
    return filtered.slice(0, 50).map(item => item.action);
  }, [registry, query]);

  // Group actions for display
  const groupedActions = useMemo(() => {
    return groupActions(filteredActions, currentPage);
  }, [filteredActions, currentPage]);

  // Flatten grouped actions for keyboard navigation
  const flatActions = useMemo(() => {
    const flat: Array<{ action: ActionRegistryItem; group: keyof GroupedActions }> = [];
    const seenIds = new Set<string>();
    
    // When query is empty, show recent actions first (if any), then regular groups
    if (!query.trim()) {
      // Add recent actions (from local storage) - top 5
      const recentActions = registry.filter(action => recentIds.includes(action.id));
      if (recentActions.length > 0) {
        const slicedActions = recentActions.slice(0, 5);
        slicedActions.forEach(action => {
          if (!seenIds.has(action.id)) {
            flat.push({ action, group: 'recent' });
            seenIds.add(action.id);
          }
        });
        
        // Return recent actions, don't show other actions when query is empty
        return flat;
      }
      
      // If no recent actions, show all available actions grouped
      Object.entries(groupedActions).forEach(([group, actions]) => {
        if (group !== 'recent' && actions.length > 0) {
          (actions as ActionRegistryItem[]).forEach(action => {
            if (!seenIds.has(action.id)) {
              flat.push({ action, group: group as keyof GroupedActions });
              seenIds.add(action.id);
            }
          });
        }
      });
      
      return flat;
    }
    
    // When there's a query, show all matching actions in proper groups
    Object.entries(groupedActions).forEach(([group, actions]) => {
      if (actions.length > 0) {
        (actions as ActionRegistryItem[]).forEach(action => {
          if (!seenIds.has(action.id)) {
            flat.push({ action, group: group as keyof GroupedActions });
            seenIds.add(action.id);
          }
        });
      }
    });
    
    return flat;
  }, [groupedActions, registry, recentIds, query]);

  // Handle query changes
  const handleQueryChange = useCallback((newQuery: string) => {
    setQuery(newQuery);
    if (onQueryChange) {
      onQueryChange(newQuery);
    }
  }, [onQueryChange]);

  // Handle keyboard navigation
  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (!isOpen) return;

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setSelectedIndex(prev => (prev + 1) % flatActions.length);
        break;
      case 'ArrowUp':
        e.preventDefault();
        setSelectedIndex(prev => (prev - 1 + flatActions.length) % flatActions.length);
        break;
      case 'Enter':
        e.preventDefault();
        if (flatActions[selectedIndex]) {
          handleSelect(flatActions[selectedIndex].action);
        }
        break;
      case 'Escape':
        e.preventDefault();
        onClose();
        break;
    }
  }, [isOpen, flatActions, selectedIndex, onClose]);

  // Handle select action
  const handleSelect = useCallback((action: ActionRegistryItem) => {
    // Add to recent actions
    setRecentIds(prev => {
      const updated = [action.id, ...prev.filter(id => id !== action.id)];
      const trimmed = updated.slice(0, 10); // Keep only last 10
      
      // Persist to localStorage
      try {
        localStorage.setItem('command-palette-recent', JSON.stringify(trimmed));
      } catch {
        // Ignore localStorage errors
      }
      
      return trimmed;
    });
    
    onSelect(action);
    onClose();
  }, [onSelect, onClose]);

  // Focus input when opened
  useEffect(() => {
    if (isOpen) {
      setQuery('');
      setSelectedIndex(0);
      inputRef.current?.focus();
    }
  }, [isOpen]);

  // Handle keyboard events
  useEffect(() => {
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  // Scroll selected item into view
  useEffect(() => {
    if (listRef.current) {
      const selectedElement = listRef.current.children[selectedIndex] as HTMLElement;
      if (selectedElement && selectedElement.scrollIntoView) {
        selectedElement.scrollIntoView({ block: 'nearest' });
      }
    }
  }, [selectedIndex]);

  if (!isOpen) return null;

  return (
    <div className="command-palette-overlay" data-testid="command-palette" onClick={onClose}>
      <div className="command-palette" onClick={e => e.stopPropagation()}>
        <div className="command-palette-header">
          <Search size={16} className="command-palette-search-icon" />
          <input
            ref={inputRef}
            type="text"
            placeholder="Search commands..."
            value={query}
            onChange={e => handleQueryChange(e.target.value)}
            className="command-palette-input"
            data-testid="command-palette-input"
          />
          {query && (
            <button
              onClick={() => setQuery('')}
              className="command-palette-clear"
              aria-label="Clear search"
            >
              <X size={14} />
            </button>
          )}
        </div>
        
        <div className="command-palette-content">
          {flatActions.length === 0 ? (
            <div className="command-palette-empty">
              <p>No matching actions. Try a different phrase or press Esc to close.</p>
            </div>
          ) : (
            <div ref={listRef} className="command-palette-list" role="menu">
              {flatActions.map(({ action, group }, index) => {
                const isSelected = index === selectedIndex;
                const Icon = () => <span className="command-palette-icon">{action.icon}</span>;
                
                return (
                  <div
                    key={action.id}
                    className={clsx(
                      'command-palette-item',
                      isSelected && 'command-palette-item-selected',
                      action.dangerous && 'command-palette-item-dangerous'
                    )}
                    role="menuitem"
                    data-testid="command-palette-item"
                    onClick={() => handleSelect(action)}
                    onMouseEnter={() => setSelectedIndex(index)}
                  >
                    <div className="command-palette-item-content">
                      <Icon />
                      <div className="command-palette-item-text">
                        <div className="command-palette-item-title">
                          <span className="command-palette-verb">{action.verb}</span>
                          {' '}
                          <span className="command-palette-noun">{action.noun}</span>
                          {action.description && (
                            <>
                              {' · '}
                              <span className="command-palette-description">{action.description}</span>
                            </>
                          )}
                        </div>
                      </div>
                      {action.shortcut && (
                        <div className="command-palette-shortcut">
                          {action.shortcut.join(' + ')}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
        
        <div className="command-palette-footer">
          <span className="command-palette-footer-text">
            <CornerDownLeft size={12} /> navigate · Enter run · Esc close
          </span>
        </div>
      </div>
    </div>
  );
}
