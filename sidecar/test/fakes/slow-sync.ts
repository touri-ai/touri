export const syncShim = `#define _GNU_SOURCE
#include <dlfcn.h>
#include <errno.h>
#include <stdatomic.h>
#include <stdio.h>
#include <string.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>

typedef int (*SyncFunction)(int);

static atomic_int recording = 0;
static atomic_int sync_count = 0;
static atomic_int sync_delay_ms = 20;
static atomic_int sqlite_only = 0;
static atomic_int fail_directory_sync = 0;
static atomic_int directory_sync_successes = 0;

static int path_contains(int descriptor, const char *fragment) {
  char descriptor_path[64];
  char path[4096];
  snprintf(descriptor_path, sizeof(descriptor_path), "/proc/self/fd/%d", descriptor);
  const ssize_t length = readlink(descriptor_path, path, sizeof(path) - 1);
  if (length < 0) return 0;
  path[length] = 0;
  return strstr(path, fragment) != NULL;
}

static int delay_sync(const char *name, int descriptor) {
  SyncFunction original = (SyncFunction)dlsym(RTLD_NEXT, name);
  if (!original) {
    errno = ENOSYS;
    return -1;
  }
  if (atomic_load(&recording) && (!atomic_load(&sqlite_only) || path_contains(descriptor, ".db"))) {
    const int delay_ms = atomic_load(&sync_delay_ms);
    struct timespec delay = {delay_ms / 1000, (delay_ms % 1000) * 1000 * 1000};
    atomic_fetch_add(&sync_count, 1);
    nanosleep(&delay, NULL);
  }
  struct stat status;
  const int directory = fstat(descriptor, &status) == 0 && S_ISDIR(status.st_mode) && path_contains(descriptor, "/attachments/");
  if (directory && atomic_exchange(&fail_directory_sync, 0)) {
    errno = EIO;
    return -1;
  }
  const int result = original(descriptor);
  if (result == 0 && directory && atomic_load(&recording)) atomic_fetch_add(&directory_sync_successes, 1);
  return result;
}

int fsync(int descriptor) { return delay_sync("fsync", descriptor); }
int fdatasync(int descriptor) { return delay_sync("fdatasync", descriptor); }

int touri_start_sync_recording(void) {
  atomic_store(&sync_count, 0);
  atomic_store(&directory_sync_successes, 0);
  atomic_store(&recording, 1);
  return 0;
}

int touri_set_sqlite_only(int enabled) {
  atomic_store(&sqlite_only, enabled);
  return 0;
}

int touri_set_sync_delay_ms(int delay_ms) {
  atomic_store(&sync_delay_ms, delay_ms);
  return 0;
}

int touri_stop_sync_recording(void) {
  atomic_store(&recording, 0);
  return atomic_load(&sync_count);
}

int touri_get_sync_count(void) {
  return atomic_load(&sync_count);
}

int touri_fail_next_directory_sync(void) {
  atomic_store(&fail_directory_sync, 1);
  return 0;
}

int touri_get_directory_sync_successes(void) {
  return atomic_load(&directory_sync_successes);
}
`
