#include <iostream>

int main() {
    int phase;
    if (!(std::cin >> phase)) return 1;
    if (phase == 1) {
        long long a, b;
        std::cin >> a >> b;
        std::cout << a + b << '\n';
    } else {
        long long value;
        std::cin >> value;
        std::cout << value * 2 << '\n';
    }
}
