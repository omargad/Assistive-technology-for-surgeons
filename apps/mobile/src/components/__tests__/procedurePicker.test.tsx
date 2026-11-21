/// <reference types="jest" />
/**
 * RV-21: a custom procedure name is replaced by "Unspecified procedure" in research exports and uploads
 * (core de-identification). The picker must say so, and ask for a specialty, which survives.
 */
import { fireEvent, render, screen } from '@testing-library/react-native';

import { ProcedurePicker } from '../ProcedurePicker';

describe('ProcedurePicker custom name', () => {
  it('explains that a custom name does not reach the research data', async () => {
    const onChange = jest.fn();
    await render(<ProcedurePicker value={null} onChange={onChange} testID="pp" />);
    expect(screen.getByTestId('pp-custom-note')).toHaveTextContent(/stays on this device.*“Unspecified procedure”.*specialty/s);
    await fireEvent.changeText(screen.getByTestId('pp-custom'), 'Revision hernia repair');
    await fireEvent.press(screen.getByText('Use custom name'));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ name: 'Revision hernia repair' }));
  });
});
