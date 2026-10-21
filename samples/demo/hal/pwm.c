#include "demo.h"

/* PWM 占空比缓存：4 路输出，初始全关 */
static unsigned char s_duty[4] = { 0u, 0u, 0u, 0u };
static unsigned char s_pwmOn = 0u;

void Pwm_Apply(unsigned char ch);

void Pwm_Init(void)
{
    unsigned char i;

    for (i = 0u; i < 4u; i++) {
        s_duty[i] = 0u;
    }
    s_pwmOn = 0u;
}

/* 设置占空比：超范围直接钳位 */
void Pwm_SetDuty(unsigned char ch, unsigned char duty)
{
    if (ch >= 4u) {
        return;
    }
    s_duty[ch] = (unsigned char)CLAMP(duty, 0u, 100u);
    Pwm_Apply(ch);
}

void Pwm_Apply(unsigned char ch)
{
    if (s_pwmOn == 0u) {
        return;
    }
    /* 真正写寄存器的地方，测试样本里留空 */
    (void)ch;
}

/* 按当前转速调整风扇与油泵占空比 */
void Pwm_Update(void)
{
    unsigned char duty;

    duty = (unsigned char)(g_rpm >> 4);
    if (duty > 90u) {
        duty = 90u;
    }

    Pwm_SetDuty(0u, duty);
    Pwm_SetDuty(1u, (unsigned char)(g_gear.current * 15u));

    if (g_gear.fault != 0u) {
        Pwm_SetDuty(2u, 100u);
    }
}

void Pwm_Stop(void)
{
    unsigned char i;

    for (i = 0u; i < 4u; i++) {
        s_duty[i] = 0u;
        Pwm_Apply(i);
    }
    s_pwmOn = 0u;
}

void Pwm_Enable(void)
{
    s_pwmOn = 1u;
}
