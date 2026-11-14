"""What every test starts from."""

import pytest

from magpylib_studio import fieldlines


@pytest.fixture(autouse=True)
def _no_field_matrices_kept():
    """The field matrices of solved sheets are kept for the process
    (`fieldlines.MATRIX_MEMORY`): a test reads none another one built."""
    fieldlines._matrices.clear()
    fieldlines._last_read.clear()
    fieldlines._too_large.clear()
    yield
    fieldlines._matrices.clear()
    fieldlines._last_read.clear()
    fieldlines._too_large.clear()


@pytest.fixture(autouse=True, scope="session")
def _a_cache_of_its_own(tmp_path_factory):
    """What an example keeps between sessions -- the magnet balls' runs --
    goes to a folder of the test session's, not the user's cache."""
    import os

    os.environ["MAGPYLIB_STUDIO_CACHE"] = str(tmp_path_factory.mktemp("cache"))
