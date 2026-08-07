# Cortex-M GDB 测试固件。一份 main.c 出两个 ELF,覆盖所有调试场景。
#
# 【本机可用的确切命令】(macOS + ArmGNUToolchain 15.2.rel1)
#   make -C packages/coding-agent/test/fixtures/gdb both \
#     CROSS=/Applications/ArmGNUToolchain/15.2.rel1/arm-none-eabi/bin/arm-none-eabi-
#
# 若 arm-none-eabi-gcc 已在 PATH 上,直接 `make both` 即可(CROSS 默认就是它)。
#
#   make                      -> fixture.elf    (cortex-m3, 链接在 0x00000000)
#   make TARGET=f4            -> fixture_f4.elf (cortex-m4, 链接在 0x08000000)
#   make both                 -> 两个都建(仓库里提交的就是这两个产物)
#   make run SCEN=hardfault   -> QEMU 无头跑一遍,semihosting 打印结果
#   make debug SCEN=hardfault -> 暂停启动,在 $(PORT) 上开 gdbserver
#   make gdb                  -> 另开一个终端 attach 上去
#
# 注意:.elf 是提交进 git 的测试资产,`make clean` 不删它们;要删用 `make distclean`。

# 交叉工具链前缀。既接受 PATH 上的名字,也接受绝对路径前缀:
#   make CROSS=/Applications/ArmGNUToolchain/15.2.rel1/arm-none-eabi/bin/arm-none-eabi-
CROSS ?= arm-none-eabi-
CC     = $(CROSS)gcc
SIZE   = $(CROSS)size
GDB    = $(CROSS)gdb

# 所有路径都相对 Makefile 自身,所以 `make -C <dir>` 和 `cd <dir> && make` 等价。
HERE := $(dir $(abspath $(lastword $(MAKEFILE_LIST))))

# ---- 目标选择 --------------------------------------------------------
# QEMU 的 lm3s6965evb / mps2-* / netduinoplus2 / stm32vldiscovery 都从
# 0x00000000 启动,所以默认构建不加改动就能在它们上面跑。
# f4 变体链接在 0x08000000,对应真实 STM32F4 的存储映射(netduinoplus2 把
# 片上 flash 同时别名到 0x0 和 0x08000000,所以它在 QEMU 上一样能跑)。
TARGET ?= base
ifeq ($(TARGET),f4)
  NAME         = fixture_f4
  FLASH_ORIGIN = 0x08000000
  CPU          = cortex-m4
  MACHINE     ?= netduinoplus2
else
  NAME         = fixture
  FLASH_ORIGIN = 0x00000000
  CPU          = cortex-m3
  # netduinoplus2 是最好的默认值:STM32F405 的存储映射够紧且真实,野指针会真的
  # BusFault。lm3s6965evb 会把越界访问悄悄吞掉,永远不出错,测不了故障场景。
  MACHINE     ?= netduinoplus2
endif

FLASH_LEN  ?= 128K
RAM_ORIGIN ?= 0x20000000
RAM_LEN    ?= 8K
PORT       ?= 3333
SCEN       ?= hello

# -g3 带 DWARF CFI,gdb 的 `backtrace` 靠它。
# -fno-unwind-tables 让 .ARM.exidx 不生成,于是不需要 libgcc 的
# __aeabi_unwind_cpp_pr0 personality routine,可以彻底 -nostdlib。
CFLAGS  = -mcpu=$(CPU) -mthumb -g3 -Og -std=c11 \
          -ffreestanding -fno-builtin \
          -fno-unwind-tables -fno-asynchronous-unwind-tables \
          -ffunction-sections -fdata-sections \
          -Wall -Wextra -Wno-unused-parameter -Wno-infinite-recursion
LDFLAGS = -nostdlib -nostartfiles -Wl,--gc-sections \
          -Wl,-Map=$(HERE)$(NAME).map -T $(HERE)$(NAME).ld

all: $(HERE)$(NAME).elf

both:
	$(MAKE) -f $(HERE)Makefile TARGET=base
	$(MAKE) -f $(HERE)Makefile TARGET=f4

# 链接脚本是生成的,一份 .ld.in 服务所有存储映射
$(HERE)$(NAME).ld: $(HERE)fixture.ld.in
	$(CC) -E -P -x c -DFLASH_ORIGIN=$(FLASH_ORIGIN) -DFLASH_LEN=$(FLASH_LEN) \
	      -DRAM_ORIGIN=$(RAM_ORIGIN) -DRAM_LEN=$(RAM_LEN) $< -o $@

# -lgcc 提供 __aeabi_* 辅助函数(除法等);在 m3+ 上无害
$(HERE)$(NAME).elf: $(HERE)main.c $(HERE)$(NAME).ld
	$(CC) $(CFLAGS) $(LDFLAGS) -o $@ $(HERE)main.c -lgcc
	@$(SIZE) $@

QEMU_COMMON = -machine $(MACHINE) -kernel $(HERE)$(NAME).elf -nographic \
              -serial none -monitor none

run: $(HERE)$(NAME).elf
	qemu-system-arm $(QEMU_COMMON) \
	  -semihosting-config enable=on,target=native,arg=$(SCEN)

debug: $(HERE)$(NAME).elf
	qemu-system-arm $(QEMU_COMMON) \
	  -semihosting-config enable=on,target=native \
	  -S -gdb tcp::$(PORT)

gdb:
	$(GDB) -q $(HERE)$(NAME).elf \
	  -ex "set pagination off" \
	  -ex "target extended-remote :$(PORT)" \
	  -ex "break main" -ex "continue"

# 只删中间产物,保留提交进 git 的 .elf
clean:
	rm -f $(HERE)*.map $(HERE)fixture.ld $(HERE)fixture_f4.ld $(HERE)*.o

distclean: clean
	rm -f $(HERE)fixture.elf $(HERE)fixture_f4.elf

.PHONY: all both run debug gdb clean distclean
