TARGET := riscv64-unknown-linux-gnu
CC := $(TARGET)-gcc
LD := $(TARGET)-gcc
OBJCOPY := $(TARGET)-objcopy
CFLAGS := -D CKB_C_STDLIB_PRINTF -fPIC -O3 -nostdinc -nostdlib -nostartfiles -fvisibility=hidden -I deps/ckb-c-stdlib -I deps/ckb-c-stdlib/libc -I deps -I deps/molecule -I . -I build -Wall -Werror -Wno-nonnull -Wno-nonnull-compare -Wno-unused-function -g
LDFLAGS := -Wl,-static -fdata-sections -ffunction-sections -Wl,--gc-sections
MOLC := moleculec
MOLC_VERSION := 0.6.1
PROTOCOL_SCHEMA_DIR := ../crates/types/schemas

# docker pull nervos/ckb-riscv-gnu-toolchain:gnu-bionic-20191012
BUILDER_DOCKER := nervos/ckb-riscv-gnu-toolchain@sha256:aae8a3f79705f67d505d1f1d5ddc694a4fd537ed1c7e9622420a470d59ba2ec3

GENERATORS := build/meta-contract-generator build/sudt-generator build/examples/sum-generator
VALIDATORS := build/meta-contract-validator build/sudt-validator build/examples/sum-validator

BINS := $(GENERATORS) $(VALIDATORS)

all-via-docker: generate-protocol
	docker run --rm -v `pwd`:/code -w /code ${BUILDER_DOCKER} bash -c "make all"

debug-all-via-docker: generate-protocol
	docker run --rm -v `pwd`:/code -w /code ${BUILDER_DOCKER} bash -c "make debug-all"

all: $(BINS)

clean:
	rm $(BINS)

debug-all: CFLAGS += -DCKB_C_STDLIB_PRINTF 
debug-all: all

build/meta-contract-generator: contracts/meta_contract.c gw_def.h generator_utils.h
	$(CC) $(CFLAGS) -DGW_GENERATOR $(LDFLAGS) -o $@ $<
	$(OBJCOPY) --only-keep-debug $@ $@.debug
	$(OBJCOPY) --strip-debug --strip-all $@

build/meta-contract-validator: contracts/meta_contract.c gw_def.h validator_utils.h
	$(CC) $(CFLAGS) -DGW_VALIDATOR $(LDFLAGS) -o $@ $<
	$(OBJCOPY) --only-keep-debug $@ $@.debug
	$(OBJCOPY) --strip-debug --strip-all $@

build/sudt-generator: contracts/sudt.c sudt_utils.h gw_def.h generator_utils.h
	$(CC) $(CFLAGS) -DGW_GENERATOR $(LDFLAGS) -o $@ $<
	$(OBJCOPY) --only-keep-debug $@ $@.debug
	$(OBJCOPY) --strip-debug --strip-all $@

build/sudt-validator: contracts/sudt.c sudt_utils.h gw_def.h validator_utils.h
	$(CC) $(CFLAGS) -DGW_VALIDATOR $(LDFLAGS) -o $@ $<
	$(OBJCOPY) --only-keep-debug $@ $@.debug
	$(OBJCOPY) --strip-debug --strip-all $@

build/examples/sum-generator: examples/sum.c gw_def.h generator_utils.h
	$(CC) $(CFLAGS) -DGW_GENERATOR $(LDFLAGS) -o $@ $<
	$(OBJCOPY) --only-keep-debug $@ $@.debug
	$(OBJCOPY) --strip-debug --strip-all $@

build/examples/sum-validator: examples/sum.c gw_def.h validator_utils.h
	$(CC) $(CFLAGS) -DGW_VALIDATOR $(LDFLAGS) -o $@ $<
	$(OBJCOPY) --only-keep-debug $@ $@.debug
	$(OBJCOPY) --strip-debug --strip-all $@
 
generate-protocol: check-moleculec-version build/blockchain.h build/godwoken.h

fmt:
	clang-format -i -style=Google $(wildcard ./*.h ./*.c)
	git diff --exit-code $(wildcard ./*.h ./*.c)

check-moleculec-version:
	test "$$(${MOLC} --version | awk '{ print $$2 }' | tr -d ' ')" = ${MOLC_VERSION}

build/blockchain.h: ${PROTOCOL_SCHEMA_DIR}/blockchain.mol
	${MOLC} --language c --schema-file $< > $@

build/godwoken.h: ${PROTOCOL_SCHEMA_DIR}/godwoken.mol
	${MOLC} --language c --schema-file $< > $@

install-tools:
	if [ ! -x "$$(command -v "${MOLC}")" ] \
			|| [ "$$(${MOLC} --version | awk '{ print $$2 }' | tr -d ' ')" != "${MOLC_VERSION}" ]; then \
		cargo install --force --version "${MOLC_VERSION}" "${MOLC}"; \
	fi

