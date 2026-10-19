#include "gear.h"
#include "can.h"
#include "adc.h"
#include "config.h"

static void Task_10ms(void);
static void Task_100ms(void);
static void Task_Shift(void);

static volatile unsigned int g_tick = 0u;

/* ISR：内部经宏参数间接调用 */
void SysTick_Handler(void)
{
    g_tick++;
    if ((g_tick % 10u) == 0u) {
        CALL(Task_10ms);                   /* 宏参数即函数名 */
    }
}

void Task_10ms(void)
{
    unsigned int rpm = Can_GetRpm();

    (void)rpm;
    Task_Shift();
}

void Task_100ms(void)
{
    Can_SendGearStatus(g_gearCtx.current);
}

void Task_Shift(void)
{
    unsigned char ok;

#ifdef CONFIG_SPORT_MODE
    ok = (unsigned char)Gear_CheckSpeed(Can_GetRpm(), Can_GetSpeed());
#else
    ok = 0u;
#endif

    if (ok) {
        INVOKE(&g_ops_4at, shift_up);      /* 函数指针 -> Gear_ShiftUp */
    } else {
        INVOKE(&g_ops_4at, shift_down);    /* 函数指针 -> Gear_ShiftDown */
    }

    Task_100ms();
}

int main(void)
{
    Can_Init();
    Adc_Init();
    Gear_Init();

    for (;;) {
        Task_10ms();
        Task_100ms();
    }
}
