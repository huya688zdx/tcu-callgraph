#include "config.h"

int Control_Read(void)
{
    if (g_rpm > g_limit) {
        Diagnostics();
    }
    return g_rpm;
}

int Monitor_Read(void)
{
    return g_rpm;
}

void Diagnostics(void)
{
    g_fault++;
}
