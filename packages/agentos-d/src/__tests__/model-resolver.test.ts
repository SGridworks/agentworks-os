import { resolveEffectiveModel } from '../services/model-resolver'

describe('resolveEffectiveModel', () => {
  it('prioritizes issue metadata model', () => {
    const issue = { metadata: { model: 'nemotron-3-nano:30b' } }
    const agent = {}
    const result = resolveEffectiveModel(issue, agent)
    expect(result).toEqual({ model: 'nemotron-3-nano:30b', source: 'ISSUE_METADATA' })
  })

  it('uses agent config model if no issue metadata', () => {
    const issue = {}
    const agent = { model: 'minimax-m2.5' }
    const result = resolveEffectiveModel(issue, agent)
    expect(result).toEqual({ model: 'minimax-m2.5', source: 'AGENT_CONFIG' })
  })

  it('uses default when neither issue nor agent config is set', () => {
    const issue = {}
    const agent = {}
    const result = resolveEffectiveModel(issue, agent)
    expect(result).toEqual({ model: 'nemotron-3-nano:30b', source: 'DEFAULT' })
  })

  it('handles missing fields gracefully', () => {
    const issue = { metadata: {} }
    const agent = { model: undefined }
    const result = resolveEffectiveModel(issue, agent)
    expect(result).toEqual({ model: 'nemotron-3-nano:30b', source: 'DEFAULT' })
  })
})