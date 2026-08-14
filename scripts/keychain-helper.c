#include <CoreFoundation/CoreFoundation.h>
#include <Security/Security.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

static void fail(const char *message, OSStatus status) {
  fprintf(stderr, "%s (status %d)\n", message, (int)status);
  exit(1);
}

static CFStringRef string_from_argument(const char *value) {
  CFStringRef result = CFStringCreateWithCString(
      kCFAllocatorDefault, value, kCFStringEncodingUTF8);
  if (result == NULL) {
    fprintf(stderr, "Unable to decode Keychain metadata\n");
    exit(64);
  }
  return result;
}

static CFDictionaryRef item_query(CFStringRef service, CFStringRef account) {
  const void *keys[] = {kSecClass, kSecAttrService, kSecAttrAccount};
  const void *values[] = {kSecClassGenericPassword, service, account};
  CFDictionaryRef query = CFDictionaryCreate(
      kCFAllocatorDefault,
      keys,
      values,
      3,
      &kCFTypeDictionaryKeyCallBacks,
      &kCFTypeDictionaryValueCallBacks);
  if (query == NULL) {
    fprintf(stderr, "Unable to prepare Keychain query\n");
    exit(1);
  }
  return query;
}

static int read_item(CFStringRef service, CFStringRef account) {
  CFDictionaryRef base_query = item_query(service, account);
  CFMutableDictionaryRef query = CFDictionaryCreateMutableCopy(
      kCFAllocatorDefault, 0, base_query);
  CFRelease(base_query);
  if (query == NULL) {
    fprintf(stderr, "Unable to prepare Keychain read\n");
    return 1;
  }
  CFDictionarySetValue(query, kSecReturnData, kCFBooleanTrue);
  CFDictionarySetValue(query, kSecMatchLimit, kSecMatchLimitOne);

  CFTypeRef result = NULL;
  OSStatus status = SecItemCopyMatching(query, &result);
  CFRelease(query);
  if (status != errSecSuccess) fail("Unable to read Keychain item", status);

  CFDataRef data = (CFDataRef)result;
  const UInt8 *bytes = CFDataGetBytePtr(data);
  CFIndex length = CFDataGetLength(data);
  if (length > 0 && write(STDOUT_FILENO, bytes, (size_t)length) != length) {
    CFRelease(result);
    fprintf(stderr, "Unable to return Keychain data\n");
    return 1;
  }
  CFRelease(result);
  return 0;
}

static int delete_item(CFStringRef service, CFStringRef account) {
  CFDictionaryRef query = item_query(service, account);
  OSStatus status = SecItemDelete(query);
  CFRelease(query);
  if (status != errSecSuccess && status != errSecItemNotFound) {
    fail("Unable to delete Keychain item", status);
  }
  return 0;
}

static int store_item(
    CFStringRef service,
    CFStringRef account,
    const char *label_argument,
    const char *comment_argument) {
  size_t capacity = 128;
  size_t length = 0;
  unsigned char *secret = malloc(capacity);
  if (secret == NULL) {
    fprintf(stderr, "Unable to allocate secret buffer\n");
    return 1;
  }

  for (;;) {
    if (length == capacity) {
      capacity *= 2;
      unsigned char *resized = realloc(secret, capacity);
      if (resized == NULL) {
        free(secret);
        fprintf(stderr, "Unable to resize secret buffer\n");
        return 1;
      }
      secret = resized;
    }
    ssize_t count = read(STDIN_FILENO, secret + length, capacity - length);
    if (count < 0) {
      free(secret);
      fprintf(stderr, "Unable to read secret input\n");
      return 1;
    }
    if (count == 0) break;
    length += (size_t)count;
  }

  if (length == 0) {
    free(secret);
    fprintf(stderr, "Missing secret input\n");
    return 64;
  }

  CFStringRef label = string_from_argument(label_argument);
  CFStringRef comment = string_from_argument(comment_argument);
  CFDataRef secret_data = CFDataCreate(kCFAllocatorDefault, secret, (CFIndex)length);
  if (secret_data == NULL) {
    free(secret);
    fprintf(stderr, "Unable to prepare secret data\n");
    return 1;
  }

  SecTrustedApplicationRef trusted_self = NULL;
  OSStatus status = SecTrustedApplicationCreateFromPath(NULL, &trusted_self);
  if (status != errSecSuccess) fail("Unable to configure Keychain access", status);
  const void *trusted_values[] = {trusted_self};
  CFArrayRef trusted_list = CFArrayCreate(
      kCFAllocatorDefault, trusted_values, 1, &kCFTypeArrayCallBacks);
  if (trusted_list == NULL) {
    fprintf(stderr, "Unable to prepare Keychain access list\n");
    return 1;
  }

  SecAccessRef access = NULL;
  status = SecAccessCreate(label, trusted_list, &access);
  if (status != errSecSuccess) fail("Unable to create Keychain access controls", status);

  const void *keys[] = {
      kSecClass,
      kSecAttrService,
      kSecAttrAccount,
      kSecAttrLabel,
      kSecAttrComment,
      kSecAttrAccess,
      kSecValueData,
  };
  const void *values[] = {
      kSecClassGenericPassword,
      service,
      account,
      label,
      comment,
      access,
      secret_data,
  };
  CFDictionaryRef item = CFDictionaryCreate(
      kCFAllocatorDefault,
      keys,
      values,
      7,
      &kCFTypeDictionaryKeyCallBacks,
      &kCFTypeDictionaryValueCallBacks);
  if (item == NULL) {
    fprintf(stderr, "Unable to prepare Keychain item\n");
    return 1;
  }

  status = SecItemAdd(item, NULL);
  for (size_t index = 0; index < length; index++) secret[index] = 0;
  free(secret);
  CFRelease(item);
  CFRelease(access);
  CFRelease(trusted_list);
  CFRelease(trusted_self);
  CFRelease(secret_data);
  CFRelease(comment);
  CFRelease(label);

  if (status != errSecSuccess) fail("Unable to store Keychain item", status);
  return 0;
}

int main(int argc, char *argv[]) {
  if (argc < 4) {
    fprintf(stderr, "Usage: keychain-helper <store|read|delete> <service> <account> [label comment]\n");
    return 64;
  }

  CFStringRef service = string_from_argument(argv[2]);
  CFStringRef account = string_from_argument(argv[3]);
  int result;
  if (strcmp(argv[1], "read") == 0 && argc == 4) {
    result = read_item(service, account);
  } else if (strcmp(argv[1], "delete") == 0 && argc == 4) {
    result = delete_item(service, account);
  } else if (strcmp(argv[1], "store") == 0 && argc == 6) {
    result = store_item(service, account, argv[4], argv[5]);
  } else {
    fprintf(stderr, "Invalid Keychain helper command\n");
    result = 64;
  }
  CFRelease(account);
  CFRelease(service);
  return result;
}
