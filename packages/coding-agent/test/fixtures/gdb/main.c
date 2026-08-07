/* fixture.c - single-file Cortex-M test target for a GDB-driving agent.
 *
 * No newlib, no startup.s, no CMSIS. Builds with -nostdlib.
 * Prints over ARM semihosting (works with zero probe and zero UART).
 *
 * Scenario is chosen at runtime so ONE elf covers every test:
 *   - from the QEMU command line: -semihosting-config ...,arg=hardfault
 *   - or from gdb:                (gdb) set var g_scenario = SC_HARDFAULT
 */

/* ------------------------------------------------------------------ */
/* semihosting                                                         */
/* ------------------------------------------------------------------ */
#define SYS_WRITE0       0x04
#define SYS_GET_CMDLINE  0x15
#define SYS_EXIT         0x18
#define ADP_APP_EXIT     0x20026

static inline long semihost(long op, void *arg)
{
    register long   r0 __asm__("r0") = op;
    register void  *r1 __asm__("r1") = arg;
    /* On Cortex-M the semihosting trap is BKPT #0xAB.  QEMU decodes it when
     * started with -semihosting-config enable=on.  On real silicon with no
     * debugger attached this same BKPT would raise a HardFault, so guard it. */
    __asm__ volatile("bkpt #0xAB" : "+r"(r0) : "r"(r1) : "memory");
    return r0;
}

static void print(const char *s) { semihost(SYS_WRITE0, (void *)s); }

static void print_hex(unsigned v)
{
    static const char d[] = "0123456789abcdef";
    char buf[11];
    buf[0] = '0'; buf[1] = 'x';
    for (int i = 0; i < 8; i++) buf[2 + i] = d[(v >> ((7 - i) * 4)) & 0xF];
    buf[10] = 0;
    print(buf);
}

/* Breakpoint anchor. A debugger should `break test_done` instead of letting
 * the program reach sh_exit(), because SYS_EXIT makes QEMU terminate the whole
 * process, which drops the gdb connection ("Remote communication error"). */
__attribute__((noinline, used)) void test_done(void)
{
    __asm__ volatile("" ::: "memory");
}

__attribute__((noreturn)) static void sh_exit(void)
{
    test_done();
    semihost(SYS_EXIT, (void *)ADP_APP_EXIT);
    for (;;) {}
}

/* ------------------------------------------------------------------ */
/* scenarios                                                           */
/* ------------------------------------------------------------------ */
enum {
    SC_HELLO = 0,      /* prints and exits cleanly - smoke test          */
    SC_BREAKPOINT,     /* calls breakpoint_target() in a loop            */
    SC_WATCHPOINT,     /* corrupts g_canary from a helper                */
    SC_HARDFAULT,      /* undefined instruction -> UsageFault -> HardFault*/
    SC_UNALIGNED,      /* CCR.UNALIGN_TRP + unaligned ld -> HardFault    */
    SC_DIVZERO,        /* CCR.DIV_0_TRP + sdiv -> HardFault              */
    SC_BADPTR,         /* store to unmapped 0xF0000000 -> BusFault       */
    SC_NULLCALL,       /* call through NULL fn ptr                       */
    SC_INFLOOP,        /* never returns; tests async interrupt/Ctrl-C    */
    SC_STACKOVF,       /* unbounded recursion until SP leaves RAM        */
    SC_SYSTICK         /* SysTick IRQ fires; tests NVIC + IRQ breakpoints*/
};

volatile int g_scenario = SC_HELLO;   /* gdb: set var g_scenario = 3 */

/* ---- watchpoint target -------------------------------------------- */
volatile unsigned g_canary = 0xC0FFEE00;
volatile unsigned g_reads;

__attribute__((noinline)) void corrupt_canary(unsigned v)
{
    g_canary = v;                 /* (gdb) watch g_canary   fires here */
}

__attribute__((noinline)) unsigned read_canary(void)
{
    return g_canary;              /* (gdb) rwatch g_canary  fires here */
}

/* ---- breakpoint target -------------------------------------------- */
volatile int g_iter;

__attribute__((noinline)) int breakpoint_target(int i)
{
    int local_sq = i * i;         /* (gdb) break breakpoint_target     */
    g_iter = i;
    return local_sq;
}

/* ---- stack overflow ------------------------------------------------ */
extern unsigned __stack_limit;
volatile unsigned g_depth;

__attribute__((noinline)) unsigned recurse(unsigned n)
{
    volatile unsigned pad[16];    /* 64 bytes of frame per call */
    pad[0] = n;
    g_depth = n;
    return pad[0] + recurse(n + 1);
}

/* ---- SysTick ------------------------------------------------------- */
#define SYST_CSR  (*(volatile unsigned *)0xE000E010)
#define SYST_RVR  (*(volatile unsigned *)0xE000E014)
#define SCB_CCR   (*(volatile unsigned *)0xE000ED14)
#define SCB_SHCSR (*(volatile unsigned *)0xE000ED24)
#define SCB_CFSR  (*(volatile unsigned *)0xE000ED28)
#define SCB_HFSR  (*(volatile unsigned *)0xE000ED2C)
#define SCB_MMFAR (*(volatile unsigned *)0xE000ED34)
#define SCB_BFAR  (*(volatile unsigned *)0xE000ED38)

volatile unsigned g_ticks;
void SysTick_Handler(void) { g_ticks++; }   /* break here to test IRQ ctx */

/* ------------------------------------------------------------------ */
/* main                                                                */
/* ------------------------------------------------------------------ */
static int streq(const char *a, const char *b)
{
    while (*a && *a == *b) { a++; b++; }
    return *a == *b;
}

static void pick_scenario_from_cmdline(void)
{
    static char buf[64];
    struct { char *p; long len; } blk = { buf, sizeof(buf) - 1 };
    if (semihost(SYS_GET_CMDLINE, &blk) != 0) return;
    buf[sizeof(buf) - 1] = 0;
    /* QEMU hands back exactly the arg= string. */
    const char *n[] = { "hello","breakpoint","watchpoint","hardfault","unaligned",
                        "divzero","badptr","nullcall","infloop","stackovf","systick" };
    for (unsigned i = 0; i < sizeof(n) / sizeof(n[0]); i++)
        if (streq(buf, n[i])) { g_scenario = (int)i; return; }
}

int main(void)
{
    pick_scenario_from_cmdline();
    print("fixture: scenario=");
    print_hex((unsigned)g_scenario);
    print("\n");

    switch (g_scenario) {
    case SC_HELLO:
        print("hello from cortex-m\n");
        break;

    case SC_BREAKPOINT:
        for (int i = 0; i < 5; i++) breakpoint_target(i);
        print("breakpoint loop done\n");
        break;

    case SC_WATCHPOINT:
        g_reads = read_canary();
        corrupt_canary(0xDEADBEEF);
        corrupt_canary(0xBADC0DE);
        print("canary now ");
        print_hex(g_canary);
        print("\n");
        break;

    case SC_HARDFAULT:
        print("about to execute undefined instruction\n");
        __asm__ volatile("udf #0");
        break;

    case SC_UNALIGNED: {
        SCB_CCR |= (1u << 3);                       /* UNALIGN_TRP */
        __asm__ volatile("dsb; isb");
        static volatile unsigned char raw[8] = {1,2,3,4,5,6,7,8};
        volatile unsigned *p = (volatile unsigned *)(void *)(raw + 1);
        print("unaligned load\n");
        g_reads = *p;                               /* -> UsageFault */
        break;
    }

    case SC_DIVZERO: {
        SCB_CCR |= (1u << 4);                       /* DIV_0_TRP */
        __asm__ volatile("dsb; isb");
        volatile int z = 0, a = 42;
        print("divide by zero\n");
        g_reads = (unsigned)(a / z);
        break;
    }

    case SC_BADPTR: {
        volatile unsigned *bad = (volatile unsigned *)0xF0000000;
        print("store to unmapped 0xf0000000\n");
        *bad = 0x12345678;                          /* -> BusFault */
        break;
    }

    case SC_NULLCALL: {
        void (*fn)(void) = (void (*)(void))0;
        print("call through null pointer\n");
        fn();                                       /* -> UsageFault INVSTATE */
        break;
    }

    case SC_INFLOOP:
        print("spinning forever (interrupt me)\n");
        for (;;) { g_iter++; }

    case SC_STACKOVF:
        print("recursing until the stack leaves RAM\n");
        g_reads = recurse(0);
        break;

    case SC_SYSTICK:
        SYST_RVR = 999;
        SYST_CSR = 7;                               /* enable | tickint | cpuclk */
        print("systick running\n");
        while (g_ticks < 5) {}
        print("got 5 ticks\n");
        SYST_CSR = 0;
        break;
    }

    print("main returning\n");
    sh_exit();
}

/* ------------------------------------------------------------------ */
/* fault handler - prints the fault status regs then exits             */
/* ------------------------------------------------------------------ */
struct frame { unsigned r0, r1, r2, r3, r12, lr, pc, psr; };

extern unsigned __data_start, __stack_top;

void hardfault_report(struct frame *f, unsigned exc_return)
{
    /* On a stack overflow the stacked frame is BELOW RAM, so dereferencing it
     * would fault again inside the handler.  Detect that and report it as the
     * stack overflow it is, instead of double-faulting. */
    unsigned lo = (unsigned)&__data_start, hi = (unsigned)&__stack_top;
    if ((unsigned)f < lo || (unsigned)f + sizeof(*f) > hi) {
        print("\n*** HARDFAULT: STACK OVERFLOW ***\n  bad frame ptr = ");
        print_hex((unsigned)f);
        print("\n  cfsr = "); print_hex(SCB_CFSR);   /* expect BFSR.STKERR 0x10 */
        print("\n  hfsr = "); print_hex(SCB_HFSR);
        print("\n  exc  = "); print_hex(exc_return);
        print("\n");
        sh_exit();
    }
    print("\n*** HARDFAULT ***\n  pc   = "); print_hex(f->pc);
    print("\n  lr   = ");  print_hex(f->lr);
    print("\n  psr  = ");  print_hex(f->psr);
    print("\n  cfsr = ");  print_hex(SCB_CFSR);
    print("\n  hfsr = ");  print_hex(SCB_HFSR);
    print("\n  mmfar= ");  print_hex(SCB_MMFAR);
    print("\n  bfar = ");  print_hex(SCB_BFAR);
    print("\n  exc  = ");  print_hex(exc_return);
    print("\n");
    sh_exit();
}

/* Naked trampoline: recovers the stacked frame (MSP or PSP) for gdb/bt. */
__attribute__((naked)) void HardFault_Handler(void)
{
    __asm__ volatile(
        "tst   lr, #4          \n"
        "ite   eq              \n"
        "mrseq r0, msp         \n"
        "mrsne r0, psp         \n"
        "mov   r1, lr          \n"
        "b     hardfault_report\n");
}

/* ------------------------------------------------------------------ */
/* startup                                                             */
/* ------------------------------------------------------------------ */
extern unsigned __data_load, __data_end, __bss_start, __bss_end;
extern unsigned __thread_stack_top;

__attribute__((noreturn)) void Reset_Handler(void)
{
    unsigned *src = &__data_load, *dst = &__data_start;
    while (dst < &__data_end) *dst++ = *src++;
    for (dst = &__bss_start; dst < &__bss_end; ) *dst++ = 0;

    /* Enable the individual fault handlers so CFSR is meaningful.
     * (Comment this out and everything escalates straight to HardFault.) */
    SCB_SHCSR |= (7u << 16);        /* USGFAULTENA | BUSFAULTENA | MEMFAULTENA */

    /* Run main() on the PROCESS stack and leave the MAIN stack for exception
     * handlers.  Without this split, the stack-overflow scenario blows the one
     * and only stack, the HardFault handler then has nowhere to push, and the
     * core enters LOCKUP -- at which point QEMU prints
     *   "qemu: fatal: Lockup: can't escalate 3 to HardFault"
     * and kills the whole process, taking the gdbserver down with it.
     * With MSP reserved for handlers, a thread-stack overflow produces a clean,
     * debuggable HardFault instead. */
    __asm__ volatile(
        "msr psp, %0      \n"
        "movs r0, #2      \n"   /* CONTROL.SPSEL = 1 -> thread mode uses PSP */
        "msr control, r0  \n"
        "isb              \n"
        :: "r"(&__thread_stack_top) : "r0", "memory");

    main();
    sh_exit();
}

void Default_Handler(void) { print("unexpected exception\n"); sh_exit(); }

/* Vector table.  16 system vectors + a few IRQs is plenty for QEMU. */
__attribute__((section(".vectors"), used))
void (*const vectors[])(void) = {
    (void (*)(void)) & __stack_top,   /* 0  initial MSP                 */
    Reset_Handler,                    /* 1  Reset                       */
    Default_Handler,                  /* 2  NMI                         */
    HardFault_Handler,                /* 3  HardFault                   */
    HardFault_Handler,                /* 4  MemManage                   */
    HardFault_Handler,                /* 5  BusFault                    */
    HardFault_Handler,                /* 6  UsageFault                  */
    0, 0, 0, 0,                       /* 7-10 reserved                  */
    Default_Handler,                  /* 11 SVCall                      */
    Default_Handler,                  /* 12 DebugMon                    */
    0,                                /* 13 reserved                    */
    Default_Handler,                  /* 14 PendSV                      */
    SysTick_Handler,                  /* 15 SysTick                     */
    [16 ... 63] = Default_Handler     /* external IRQs                  */
};
