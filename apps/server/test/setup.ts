// Silence the expected node:sqlite ExperimentalWarning in test output (see src/warnings.ts).
import { installWarningFilter } from '../src/warnings';

installWarningFilter();
