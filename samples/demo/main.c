#include "demo.h"

/* 全局状态的集中定义处 */
volatile unsigned int g_tick = 0u;
unsigned short        g_rpm = 0u;
unsigned short        g_speed = 0u;
int                   g_faultCode = 0;
unsigned char         g_ignition = 0u;

/* 上电初始化：把各模块拉起来，最后读一次 NVM */
void App_Init(void)
{
    g_tick = 0u;
    g_faultCode = 0;
    g_ignition = 0u;

    Timer_Init();
    Can_Init();
    Adc_Init();
    Pwm_Init();
    Nvm_Init();
    Diag_Init();
    Shift_Init();

    Nvm_Load();
    g_gear.ready = 1u;
}

/* 10ms 周期任务：采集 → 换挡判断 → 上报 */
void App_Task10ms(void)
{
    unsigned short rpm;

    Adc_Start();
    Can_Poll();

    rpm = Adc_Get(0u);
    g_rpm = rpm;
    g_speed = Adc_Get(1u);

    Shift_Check(g_rpm, g_speed);

    if (g_ignition != 0u) {
        Can_SendGearStatus();
    }

    g_tick++;
}

/* 100ms 周期任务：诊断 + 存储 */
void App_Task100ms(void)
{
    Diag_Task();

    if (g_faultCode != 0) {
        Diag_Report((unsigned char)g_faultCode);
    }

    if ((g_tick % 100u) == 0u) {
        Nvm_Save();
    }
}

int main(void)
{
    App_Init();

    for (;;) {
        if (g_tick == 0u) {
            g_ignition = 1u;
        }
        App_Task10ms();
        if ((g_tick % 10u) == 0u) {
            App_Task100ms();
        }
    }
}
