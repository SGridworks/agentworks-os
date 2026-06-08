import { render, screen } from '@testing-library/react';
import ApprovalQueuePage from './page';

test('renders approval queue placeholder', () => {
  render(<ApprovalQueuePage />);
  const heading = screen.getByRole('heading', { name: /approval queue/i });
  expect(heading).toBeInTheDocument();
});
